import { describe, expect, it } from 'vitest'
import { isPublicCorsPath, resolveCorsOrigin, serviceGatewayRewritePath } from './middleware'

const canon = () => 'https://app.example.com'

describe('resolveCorsOrigin', () => {
  it('wildcard: returns * without credentials', () => {
    expect(resolveCorsOrigin('https://any.example.org', '*', canon)).toEqual({
      origin: '*',
      credentials: false,
    })
  })

  it('whitelist hit: echoes the request origin with credentials', () => {
    const allowed = 'https://a.example.com, https://b.example.com'
    expect(resolveCorsOrigin('https://b.example.com', allowed, canon)).toEqual({
      origin: 'https://b.example.com',
      credentials: true,
    })
  })

  it('whitelist miss: no CORS origin emitted', () => {
    const allowed = 'https://a.example.com'
    expect(resolveCorsOrigin('https://evil.example.org', allowed, canon)).toEqual({
      origin: null,
      credentials: false,
    })
  })

  it('unset: falls back to canonical with credentials', () => {
    expect(resolveCorsOrigin('https://whatever.example.org', undefined, canon)).toEqual({
      origin: 'https://app.example.com',
      credentials: true,
    })
    expect(resolveCorsOrigin(null, '', canon)).toEqual({
      origin: 'https://app.example.com',
      credentials: true,
    })
  })

  it('does not evaluate canonical in wildcard or whitelist modes', () => {
    const throwing = (): string => {
      throw new Error('canonical should not be evaluated')
    }
    expect(() => resolveCorsOrigin('https://any.example.org', '*', throwing)).not.toThrow()
    expect(() =>
      resolveCorsOrigin('https://b.example.com', 'https://b.example.com', throwing)
    ).not.toThrow()
    expect(() =>
      resolveCorsOrigin('https://evil.example.org', 'https://a.example.com', throwing)
    ).not.toThrow()
  })
})

describe('isPublicCorsPath', () => {
  it('matches /api/form paths (public CORS lives in next.config)', () => {
    expect(isPublicCorsPath('/api/form/abc')).toBe(true)
    expect(isPublicCorsPath('/api/form/abc/submit')).toBe(true)
    expect(isPublicCorsPath('/api/form')).toBe(true)
  })

  it('matches /api/workflows/:id/execute', () => {
    expect(isPublicCorsPath('/api/workflows/wf_123/execute')).toBe(true)
  })

  it('does not match other /api paths', () => {
    expect(isPublicCorsPath('/api/employee/channels')).toBe(false)
    expect(isPublicCorsPath('/api/workflows/wf_123/status')).toBe(false)
    expect(isPublicCorsPath('/api/formatter')).toBe(false)
  })
})

describe('serviceGatewayRewritePath', () => {
  it('routes a custom public hostname through the transparent service gateway', () => {
    expect(
      serviceGatewayRewritePath('reports.example.com', 'app.example.com', '/assets/app.css')
    ).toBe('/service-gateway/assets/app.css')
  })

  it('leaves canonical and already-rewritten requests unchanged', () => {
    expect(serviceGatewayRewritePath('app.example.com', 'app.example.com', '/skills')).toBeNull()
    expect(
      serviceGatewayRewritePath(
        'reports.example.com',
        'app.example.com',
        '/service-gateway/assets/app.css'
      )
    ).toBeNull()
  })

  it('does not treat the shared public service host as a custom service domain', () => {
    expect(
      serviceGatewayRewritePath(
        'services.example.com',
        'app.example.com',
        '/services/inst-1/assets/app.css',
        'services.example.com'
      )
    ).toBeNull()
  })

  it('accepts a proxy-forwarded public service host when the external port is omitted', () => {
    expect(
      serviceGatewayRewritePath(
        'services.example.com',
        'app.example.com',
        '/services/inst-1/',
        'services.example.com:63080'
      )
    ).toBeNull()
  })

  it('accepts a proxy-forwarded canonical host containing multiple values', () => {
    expect(
      serviceGatewayRewritePath(
        '192.168.60.50:6100, 0.0.0.0:6100',
        '192.168.60.50:6100',
        '/dashboard'
      )
    ).toBeNull()
  })

  it.each(['localhost:6100', '127.0.0.1:6100', '[::1]:6100'])(
    'treats the local application alias %s as the canonical application',
    (requestHost) => {
      expect(
        serviceGatewayRewritePath(requestHost, '192.168.60.50:6100', '/services/inst-1/')
      ).toBeNull()
    }
  )
})
