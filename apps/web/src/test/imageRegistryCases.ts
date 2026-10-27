/** 镜像弹窗与 mock adapter 共用的地址矩阵，覆盖显式填写官方源的常见写法。 */
export const officialImageRegistries = [
  '', ' \t ', ' https://REGISTRY-1.DOCKER.IO:443/// ',
  ...['registry-1.docker.io', 'docker.io', 'index.docker.io'].flatMap((host) =>
    ['', 'https://'].flatMap((scheme) =>
      ['', '/', ':443', ':443/'].map((suffix) => `${scheme}${host}${suffix}`),
    ),
  ),
]

export const customImageRegistries = [
  'mirror.example.com', 'https://mirror.example.com/',
  'docker.io:5000', 'index.docker.io:444',
  'registry-1.docker.io.evil.example', 'notdocker.io',
]

export const invalidImageRegistries = [
  'http://docker.io', 'https://docker.io/v2/', 'docker.io?query=1', 'docker.io#fragment',
  'https://user:password@docker.io', 'https://registry-1.docker.io@evil.example',
  'docKer.io',
]
