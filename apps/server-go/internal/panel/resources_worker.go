package panel

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func (w Worker) saveResources(r *taskRecord) error {
	r.UpdatedAt = time.Now().UTC()
	return w.Store.lock(func() error { return w.Store.save(*r) })
}
func (w Worker) checkBuildResources(ctx context.Context, r *taskRecord) error {
	host, ok := w.Host.(resourceHost)
	if !ok {
		if r.ResourcePlan != nil {
			return fmt.Errorf("宿主资源检查不可用")
		}
		return nil
	}
	observation, err := host.ObserveResources(ctx)
	if err != nil {
		return err
	}
	w.Store.appendLog(r.ID, fmt.Sprintf("更新资源：内存总量 %.0f MiB；可用 %.0f MiB；构建门槛 1536 MiB；可用磁盘 %.0f MiB；交换空间不计入可用内存\n", float64(observation.Memory.TotalBytes)/(1<<20), float64(observation.Memory.AvailableBytes)/(1<<20), float64(observation.DiskAvailable)/(1<<20)))
	if observation.Memory.AvailableBytes < requiredBuildMemory && (r.ResourcePlan == nil || !r.ResourcePlan.StopPanel && len(r.ResourceTargets) == 0) {
		return resourceError(observation.Memory.AvailableBytes)
	}
	return nil
}
func (w Worker) prepareBuildResources(ctx context.Context, r *taskRecord) error {
	host, ok := w.Host.(resourceHost)
	if !ok {
		return nil
	}
	observation, err := host.ObserveResources(ctx)
	if err != nil {
		return err
	}
	if observation.Memory.AvailableBytes >= requiredBuildMemory {
		return nil
	}
	if r.ResourcePlan == nil {
		return resourceError(observation.Memory.AvailableBytes)
	}
	if err = w.phase(r, "preparing-resources"); err != nil {
		return err
	}
	if err = host.PrepareResourceRecovery(ctx, r.ID, r.Worker); err != nil {
		return err
	}
	// Check every selected identity before taking the first service down. The
	// confirmed snapshot is the maximum stop scope, never a license to add targets.
	for _, target := range r.ResourceTargets {
		state, e := host.InspectResource(ctx, target)
		if e != nil {
			return e
		}
		if state.Running && state.Generation != target.Generation {
			return fmt.Errorf("%s 启动代次已变化，请重新预检", target.Name)
		}
	}
	for _, target := range r.ResourceTargets {
		state, e := host.InspectResource(ctx, target)
		if e != nil {
			return e
		}
		if !state.Running {
			continue
		}
		if state.Generation != target.Generation {
			return fmt.Errorf("%s 启动代次已变化，未停止", target.Name)
		}
		r.ResourceStops = append(r.ResourceStops, resourceStop{Target: target, Generation: state.Generation})
		if err = w.saveResources(r); err != nil {
			return err
		}
		index := len(r.ResourceStops) - 1
		if err = host.SetResourceRunning(ctx, target, false); err != nil {
			if errors.Is(err, errResourceAlreadyStopped) {
				r.ResourceStops[index].Restored = true
				if err = w.saveResources(r); err != nil {
					return err
				}
				continue
			}
			return fmt.Errorf("停止 %s 的结果未确认：%w", target.Name, err)
		}
		state, err = host.InspectResource(ctx, target)
		if err != nil || state.Running {
			return fmt.Errorf("停止 %s 后未能确认停止状态：%v", target.Name, err)
		}
		r.ResourceStops[index].Stopped = true
		r.ResourceStops[index].Generation = state.Generation
		if err = w.saveResources(r); err != nil {
			return err
		}
		w.Store.appendLog(r.ID, "已为更新停止："+target.Name+"\n")
		observation, err = host.ObserveResources(ctx)
		if err != nil {
			return err
		}
		if observation.Memory.AvailableBytes >= requiredBuildMemory {
			return nil
		}
	}
	if r.ResourcePlan.StopPanel {
		r.PanelStopIntent = true
		r.PanelRestored = false
		if err = w.saveResources(r); err != nil {
			return err
		}
		w.Store.appendLog(r.ID, "即将提前停止面板；更新由独立维护进程继续，活动 Agent 中断后需手动继续\n")
		if err = w.Host.Stop(ctx); err != nil {
			return fmt.Errorf("提前停止面板未确认：%w", err)
		}
	}
	// Kernel accounting may settle shortly after systemd/Docker confirms exit.
	for attempt := 0; attempt < 5; attempt++ {
		observation, err = host.ObserveResources(ctx)
		if err != nil {
			return err
		}
		if observation.Memory.AvailableBytes >= requiredBuildMemory {
			return nil
		}
		if attempt < 4 {
			timer := time.NewTimer(250 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
	}
	return resourceError(observation.Memory.AvailableBytes)
}

func (w Worker) restoreResources(ctx context.Context, r *taskRecord, startPanel bool) error {
	if !r.resourcesPending() {
		return nil
	}
	if err := w.phase(r, "restoring-resources"); err != nil {
		return err
	}
	var result error
	if r.PanelStopIntent && !r.PanelRestored {
		if startPanel {
			if err := w.Host.Start(ctx); err != nil {
				result = errors.Join(result, fmt.Errorf("恢复面板失败：%w", err))
			} else {
				ports, commit := r.OldPorts, ""
				if r.Committed {
					ports = r.NewPorts
					commit = r.TargetCommit
				}
				if err = w.Host.Healthy(ctx, ports, commit); err != nil {
					result = errors.Join(result, err)
				} else {
					r.PanelRestored = true
					if err = w.saveResources(r); err != nil {
						return errors.Join(result, err)
					}
				}
			}
		} else {
			// ExecStartPre owns the subsequent service start; never recursively start it.
			r.PanelRestored = true
			if err := w.saveResources(r); err != nil {
				return err
			}
		}
	}
	host, ok := w.Host.(resourceHost)
	if !ok {
		if len(r.ResourceStops) > 0 {
			return errors.Join(result, fmt.Errorf("业务资源恢复接口不可用"))
		}
		return result
	}
	for i := len(r.ResourceStops) - 1; i >= 0; i-- {
		stop := &r.ResourceStops[i]
		if stop.Restored {
			continue
		}
		state, err := host.InspectResource(ctx, stop.Target)
		if err != nil {
			result = errors.Join(result, fmt.Errorf("恢复 %s 前核对失败：%w", stop.Target.Name, err))
			continue
		}
		if !state.Running {
			if !stop.Stopped {
				result = errors.Join(result, fmt.Errorf("%s 的停止回执未确认，已保留恢复账本等待核实", stop.Target.Name))
				continue
			}
			if !resourceRestoreGenerationAllowed(stop.Target, stop.Generation, state.Generation) {
				result = errors.Join(result, fmt.Errorf("%s 的停止代次无法确认或已变化，未启动；已保留恢复账本，请在服务器核实后手动恢复", stop.Target.Name))
				continue
			}
			restoreTarget := stop.Target
			restoreTarget.Generation = state.Generation
			if err = host.SetResourceRunning(ctx, restoreTarget, true); err != nil {
				result = errors.Join(result, fmt.Errorf("恢复 %s 失败：%w", stop.Target.Name, err))
				continue
			}
			state, err = host.InspectResource(ctx, stop.Target)
			if err != nil || !state.Running {
				result = errors.Join(result, fmt.Errorf("恢复 %s 后运行状态未确认：%v", stop.Target.Name, err))
				continue
			}
		}
		stop.Restored = true
		if err = w.saveResources(r); err != nil {
			return errors.Join(result, err)
		}
		w.Store.appendLog(r.ID, "已恢复本次停止的业务："+stop.Target.Name+"\n")
	}
	return result
}

func resourceRestoreGenerationAllowed(target resourceTarget, stopped, current string) bool {
	if stopped != current {
		return false
	}
	if target.Kind != "service" {
		return true
	}
	parts := strings.Split(stopped, ":")
	if len(parts) != 3 || !resourceBootPattern.MatchString(parts[0]) || parts[1] != "inactive" {
		return false
	}
	stamp, err := strconv.ParseUint(parts[2], 10, 64)
	return err == nil && stamp > 0
}

// Finalize is invoked by systemd ExecStopPost, after the main worker and its
// children have exited. Its own unit is still deactivating, so probing that unit
// here would incorrectly report the dead main worker as alive.
func (w Worker) Finalize(ctx context.Context, id string) error {
	if !idPattern.MatchString(id) {
		return fmt.Errorf("任务编号无效")
	}
	lock, err := w.Store.tryWorkerLock()
	if err != nil {
		return fmt.Errorf("维护收尾未取得执行锁：%w", err)
	}
	defer lock.Close()
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	r, err := w.Store.read(id)
	if err != nil {
		return err
	}
	if Active(r.State) || r.State == "recovery-failed" || r.resourcesPending() {
		if r.Committed {
			if err = w.restoreResources(ctx, &r, true); err != nil {
				r.State = "recovery-failed"
				r.Error = "版本已更新，业务资源恢复失败：" + err.Error() + recoveryHint(id)
			} else {
				r.State = "succeeded"
				r.Error = ""
			}
			if saveErr := w.phase(&r, "finished"); saveErr != nil {
				return saveErr
			}
		} else {
			err = w.finishFailure(&r, fmt.Errorf("维护执行进程已结束，已尝试恢复原版本与本次停止的业务"))
		}
	}
	if !Active(r.State) && r.State != "recovery-failed" && !r.resourcesPending() && r.Worker == filepath.Join(w.Store.tasksDir(), id+".worker") {
		if e := os.RemoveAll(filepath.Join("/var/tmp/elysian-build", id)); e != nil {
			return e
		}
		if e := os.Remove(r.Worker); e != nil && !os.IsNotExist(e) {
			return e
		}
	}
	return err
}
