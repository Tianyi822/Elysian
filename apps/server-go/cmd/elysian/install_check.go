package main

import "fmt"

func installCheckBeforeDependencies(args []string) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	if len(args) == 1 && args[0] == "--before-platform-dependencies" {
		return true, nil
	}
	return false, fmt.Errorf("安装预检仅接受 --before-platform-dependencies 阶段参数")
}
