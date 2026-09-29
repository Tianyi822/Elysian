/*
 * 依赖引导弹窗的集中文案：面板不代装，弹窗只呈现静态安装步骤与「重新检测」
 * 入口（文案集中先例：containerCopy.ts）。步骤口径与 docker-compose.yml 注释里
 * 的宿主侧安装说明一致（官方 apt 仓库、systemd 常驻、admin unix socket、
 * 目录级 bind 的理由），不引入第二套说法。successNotice 供 store 的成功通知
 * 与弹窗文案共用同一字面量。
 */

export type DependencyGuideKind = 'docker' | 'caddy'

export type DependencyGuideContent = {
  title: string
  /** 引导语；同时是 Dialog.Description，承载「面板不会代你执行任何安装命令」声明。 */
  lead: string
  /** 安装步骤（ol 逐条呈现）；命令由运维人员在面板外的终端执行。 */
  steps: readonly string[]
  /** 依赖经「重新检测」转就绪时的成功通知文案（store 发、单一字面量）。 */
  successNotice: string
}

export const DEPENDENCY_GUIDE_CONTENT: Record<DependencyGuideKind, DependencyGuideContent> = {
  docker: {
    title: '安装 Docker',
    lead: 'Docker 引擎不可用，容器、数据库与网站功能都依赖宿主 Docker。面板不会代你执行任何安装命令，请在服务器上自行完成安装或升级后回来重新检测。',
    steps: [
      '在服务器上执行 Docker 官方安装脚本：curl -fsSL https://get.docker.com | sh；或按官方文档配置 apt 仓库后执行 apt-get install docker-ce docker-ce-cli containerd.io。',
      '启动并设为开机自启：systemctl enable --now docker。',
      '确认面板能连到引擎：面板经 ELYSIAN_DOCKER_SOCKET（缺省 /var/run/docker.sock）连接引擎；编排部署时该 socket 由 compose 挂载，装好后重启面板容器即可接通。',
      '回到本面板点击「重新检测」。',
    ],
    successNotice: 'Docker 已就绪',
  },
  caddy: {
    title: '安装 Caddy',
    lead: '反向代理通道不可用，域名路由与 HTTPS 证书需要宿主上的系统级 Caddy。面板不会代你执行任何安装命令；站点容器不受影响，照常运行。',
    steps: [
      '按 Caddy 官方文档配置系统仓库（Debian/Ubuntu 为 cloudsmith 源）后执行 apt-get install caddy，或下载官方二进制自行安置。',
      '在 /etc/caddy/Caddyfile 全局段把管理端点绑到 unix socket：admin unix//run/caddy/admin.sock（与面板的 ELYSIAN_CADDY_SOCKET 同值，缺省 /run/caddy/admin.sock）。',
      '保证 /run/caddy 开机即在（systemd drop-in RuntimeDirectory=caddy 或 tmpfiles.d），并执行 systemctl enable --now caddy。',
      '面板容器以目录级 bind 挂载 /run/caddy（compose 已配置），Caddy 起来后回到本面板点击「重新检测」。',
    ],
    successNotice: 'Caddy 管理通道已就绪',
  },
}
