import { describe, expect, it } from 'vitest'
import { CONTAINERS } from '../../adapters/mock/containersData'
import {
  draftPortHostIp,
  emptyDraft,
  hasCreateErrors,
  toCreateInput,
  validateCreateDraft,
} from './containerCreateForm'

describe('创建表单校验', () => {
  it('空草稿只有镜像必选错误', () => {
    const errors = validateCreateDraft(emptyDraft(), CONTAINERS)
    expect(errors.imageId).toBe('请选择镜像')
    expect(errors.name).toBeUndefined()
    expect(hasCreateErrors(errors)).toBe(true)
  })

  it('合法草稿无错误；toCreateInput 过滤空行、端口转数字、空白命令转 undefined', () => {
    const draft = {
      ...emptyDraft(),
      imageId: 'img-redis',
      name: 'redis-echo',
      ports: [
        { containerPort: '6379', hostPort: '16379', protocol: 'tcp' as const, public: false },
        { containerPort: '', hostPort: '', protocol: 'tcp' as const, public: false },
      ],
      env: [
        { key: 'TZ', value: 'Asia/Shanghai' },
        { key: '', value: '' },
      ],
      volumes: [{ hostPath: '/srv/redis', containerPath: '/data' }],
      command: '   ',
    }
    const errors = validateCreateDraft(draft, CONTAINERS)
    expect(hasCreateErrors(errors)).toBe(false)
    expect(toCreateInput(draft)).toEqual({
      name: 'redis-echo',
      imageId: 'img-redis',
      ports: [{ containerPort: 6379, hostPort: 16379, protocol: 'tcp', hostIp: '127.0.0.1' }],
      env: [{ key: 'TZ', value: 'Asia/Shanghai' }],
      volumes: [{ hostPath: '/srv/redis', containerPath: '/data' }],
      command: undefined,
      restartPolicy: 'no',
    })
  })

  it('端口映射默认绑回环，勾选对外开放写 0.0.0.0', () => {
    const draft = {
      ...emptyDraft(),
      imageId: 'img-redis',
      ports: [{ containerPort: '80', hostPort: '18080', protocol: 'tcp' as const, public: true }],
    }
    expect(toCreateInput(draft).ports[0]?.hostIp).toBe('0.0.0.0')
    expect(draftPortHostIp({ public: false })).toBe('127.0.0.1')
  })

  it('名称重名与非法字符分别报错', () => {
    const base = { ...emptyDraft(), imageId: 'img-redis' }
    expect(validateCreateDraft({ ...base, name: 'nginx-proxy' }, CONTAINERS).name).toBe('容器名称已存在')
    expect(validateCreateDraft({ ...base, name: '缓存' }, CONTAINERS).name).toContain('字母或数字开头')
  })

  it('端口越界、与现有容器宿主端口冲突、表单内重复都报错', () => {
    const base = { ...emptyDraft(), imageId: 'img-redis' }
    const outOfRange = validateCreateDraft(
      { ...base, ports: [{ containerPort: '0', hostPort: '16379', protocol: 'tcp' as const, public: false }] },
      CONTAINERS,
    )
    expect(outOfRange.ports[0]?.containerPort).toBe('容器端口须为 1-65535 的整数')

    const conflict = validateCreateDraft(
      { ...base, ports: [{ containerPort: '6379', hostPort: '8080', protocol: 'tcp' as const, public: false }] },
      CONTAINERS,
    )
    expect(conflict.ports[0]?.hostPort).toBe('宿主端口已被占用')

    const dup = validateCreateDraft(
      {
        ...base,
        ports: [
          { containerPort: '6379', hostPort: '16380', protocol: 'tcp' as const, public: false },
          { containerPort: '6380', hostPort: '16380', protocol: 'tcp' as const, public: false },
        ],
      },
      CONTAINERS,
    )
    expect(dup.ports[0]?.hostPort).toBe('宿主端口已被占用')
    expect(dup.ports[1]?.hostPort).toBe('宿主端口已被占用')
  })

  it('tcp 与 udp 共用同一宿主端口不视为冲突', () => {
    const base = { ...emptyDraft(), imageId: 'img-redis' }
    const errors = validateCreateDraft(
      {
        ...base,
        ports: [
          { containerPort: '80', hostPort: '29999', protocol: 'tcp' as const, public: false },
          { containerPort: '53', hostPort: '29999', protocol: 'udp' as const, public: false },
        ],
      },
      CONTAINERS,
    )
    expect(errors.ports[0]?.hostPort).toBeUndefined()
    expect(errors.ports[1]?.hostPort).toBeUndefined()
    expect(hasCreateErrors(errors)).toBe(false)
  })

  it('启动命令分词失败时报错，空白或仅空白不报错', () => {
    const base = { ...emptyDraft(), imageId: 'img-redis' }
    const bad = validateCreateDraft({ ...base, command: '"unclosed' }, CONTAINERS)
    expect(bad.command).toContain('引号')
    expect(hasCreateErrors(bad)).toBe(true)

    const ok = validateCreateDraft({ ...base, command: 'redis-server --appendonly yes' }, CONTAINERS)
    expect(ok.command).toBeUndefined()
    expect(hasCreateErrors(ok)).toBe(false)

    const blank = validateCreateDraft({ ...base, command: '  \t  ' }, CONTAINERS)
    expect(blank.command).toBeUndefined()
  })

  it('环境变量空 KEY、非法 KEY、重复 KEY 与卷空路径、重复容器路径报错', () => {
    const base = { ...emptyDraft(), imageId: 'img-redis' }
    expect(validateCreateDraft({ ...base, env: [{ key: '', value: 'x' }] }, CONTAINERS).env[0]?.key).toBe('变量名不能为空')
    expect(validateCreateDraft({ ...base, env: [{ key: '1BAD', value: 'x' }] }, CONTAINERS).env[0]?.key).toBe(
      '环境变量名无效',
    )
    const dupEnv = validateCreateDraft(
      { ...base, env: [{ key: 'TZ', value: 'a' }, { key: 'TZ', value: 'b' }] },
      CONTAINERS,
    )
    expect(dupEnv.env[1]?.key).toBe('变量名重复')

    expect(
      validateCreateDraft({ ...base, volumes: [{ hostPath: '', containerPath: '/data' }] }, CONTAINERS).volumes[0]?.hostPath,
    ).toBe('宿主机路径不能为空')
    const dupVol = validateCreateDraft(
      {
        ...base,
        volumes: [
          { hostPath: '/a', containerPath: '/data' },
          { hostPath: '/b', containerPath: '/data' },
        ],
      },
      CONTAINERS,
    )
    expect(dupVol.volumes[1]?.containerPath).toBe('容器路径重复')
  })
})
