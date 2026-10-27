import { describe, expect, it } from 'vitest'
import { isOfficialImageRegistry } from './imageReference'

describe('Docker Hub 官方镜像源识别', () => {
  it('留空与空白使用官方源', () => {
    expect(isOfficialImageRegistry('')).toBe(true)
    expect(isOfficialImageRegistry(' \t ')).toBe(true)
  })

  it.each(['registry-1.docker.io', 'docker.io', 'index.docker.io'])('识别 %s 的协议、端口、大小写与尾斜杠', (host) => {
    for (const scheme of ['', 'https://']) {
      for (const suffix of ['', '/', ':443', ':443/']) {
        expect(isOfficialImageRegistry(`${scheme}${host}${suffix}`)).toBe(true)
        expect(isOfficialImageRegistry(` ${scheme}${host.toUpperCase()}${suffix} `)).toBe(true)
      }
    }
  })

  it.each([
    'mirror.example.com', 'docker.io:5000', 'index.docker.io:444',
    'registry-1.docker.io.evil.example', 'notdocker.io',
    'http://docker.io', 'https://docker.io/v2/', 'docker.io?query=1', 'docker.io#fragment',
    'https://user:password@docker.io', 'https://registry-1.docker.io@evil.example',
    'docker.io:0', 'docker.io:65536', 'docker.io:443:443', 'docKer.io',
  ])('不把非官方或非法地址 %s 识别为官方源', (registry) => {
    expect(isOfficialImageRegistry(registry)).toBe(false)
  })
})
