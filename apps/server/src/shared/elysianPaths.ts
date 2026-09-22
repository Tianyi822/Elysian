import { homedir } from 'node:os'
import { join } from 'node:path'

/*
 * 面板自管数据目录：统一放在部署机器的 ~/.Elysian 下、按类别分目录。
 * 容器内以 root 运行时 ~ 即 /root——compose 把持久卷挂在 /var/lib/elysian，
 * 并建立符号链接 /root/.Elysian → /var/lib/elysian（卷不能直接挂 /root，
 * 否则会吞掉 /root/.bun）。所有路径经由 homedir 解析，部署形态（单进程直跑）
 * 下自然落到真实用户主目录，代码不感知差异。
 *
 * 系统自身的文件（/etc/ufw 规则、/etc/ssh/sshd_config、各账号 authorized_keys）
 * 不属于面板数据，仍由面板在原位读写；这里只放面板自己产生与拥有的文件。
 */
export const ELYSIAN_HOME = join(homedir(), '.Elysian')

/** 数据库：metrics 指标库与防火墙规则时间账本。 */
export const ELYSIAN_DATA_DIR = join(ELYSIAN_HOME, 'data')
/** 日志：面板托管的 sshd 定向日志。 */
export const ELYSIAN_LOGS_DIR = join(ELYSIAN_HOME, 'logs')
/** 状态：面板自己记录的事实时间戳（启停、密码重置）。 */
export const ELYSIAN_STATE_DIR = join(ELYSIAN_HOME, 'state')
/** 备份：写系统文件前的应用侧备份（如 before.rules）。 */
export const ELYSIAN_BACKUPS_DIR = join(ELYSIAN_HOME, 'backups')
/** 临时：密钥生成等工作区，即生即灭。 */
export const ELYSIAN_TMP_DIR = join(ELYSIAN_HOME, 'tmp')
/** 配置：预留给将来的面板配置文件，本期没有文件形态。 */
export const ELYSIAN_CONFIG_DIR = join(ELYSIAN_HOME, 'config')
/** sshd 主机密钥：持久在卷上，/etc/ssh/ssh_host_* 以符号链接指向这里。 */
export const ELYSIAN_HOST_KEYS_DIR = join(ELYSIAN_HOME, 'ssh', 'host-keys')

export const ELYSIAN_PATHS = {
  metricsSqlite: join(ELYSIAN_DATA_DIR, 'metrics.sqlite'),
  firewallSqlite: join(ELYSIAN_DATA_DIR, 'firewall.sqlite'),
  sshdLog: join(ELYSIAN_LOGS_DIR, 'sshd.log'),
  sshChangedAt: join(ELYSIAN_STATE_DIR, 'ssh-changed-at'),
  sshRootPasswordResetAt: join(ELYSIAN_STATE_DIR, 'ssh-root-password-reset-at'),
  keygenWorkspace: join(ELYSIAN_TMP_DIR, 'ssh-keygen'),
} as const
