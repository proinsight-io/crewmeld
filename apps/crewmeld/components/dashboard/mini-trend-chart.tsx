'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/use-translation'

interface MiniTrendChartProps {
  data: {
    date: string
    value: number
  }[]
  height?: number
  color?: string
}

export function MiniTrendChart({ data, height = 80, color = '#2563eb' }: MiniTrendChartProps) {
  const { t } = useTranslation()
  const uid = useId().replace(/:/g, '')
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(280)
  const [tooltip, setTooltip] = useState<{
    x: number
    y: number
    date: string
    value: number
  } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(el)
    setWidth(Math.round(el.clientWidth))
    return () => observer.disconnect()
  }, [])

  if (data.length === 0) {
    return (
      <div
        className='flex items-center justify-center text-muted-foreground text-sm'
        style={{ height }}
      >
        {t('dashboard.insufficientData')}
      </div>
    )
  }

  const paddingX = 20
  const paddingY = 12
  const chartWidth = width - paddingX * 2
  const chartHeight = height - paddingY * 2

  const maxValue = Math.max(...data.map((d) => d.value), 1)
  const minValue = Math.min(...data.map((d) => d.value), 0)
  const range = maxValue - minValue || 1

  const points = data.map((d, i) => {
    const x = paddingX + (i / Math.max(data.length - 1, 1)) * chartWidth
    const y = paddingY + chartHeight - ((d.value - minValue) / range) * chartHeight
    return { x, y, ...d }
  })

  // Smooth Bezier curve
  const smoothPath = points.reduce((path, p, i) => {
    if (i === 0) return `M ${p.x} ${p.y}`
    const prev = points[i - 1]
    const cpx = (prev.x + p.x) / 2
    return `${path} C ${cpx} ${prev.y} ${cpx} ${p.y} ${p.x} ${p.y}`
  }, '')

  const areaPath = `${smoothPath} L ${points[points.length - 1].x} ${height - paddingY} L ${points[0].x} ${height - paddingY} Z`

  const gradientId = `trendGradient-${uid}`

  return (
    <div ref={containerRef} className='relative' style={{ height }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        style={{ display: 'block' }}
      >
        <defs>
          <linearGradient id={gradientId} x1='0' y1='0' x2='0' y2='1'>
            <stop offset='0%' stopColor={color} stopOpacity='0.2' />
            <stop offset='100%' stopColor={color} stopOpacity='0' />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={smoothPath}
          fill='none'
          stroke={color}
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
        {points.map((p, i) => (
          <g
            key={i}
            className='cursor-pointer'
            onMouseEnter={() => setTooltip({ x: p.x, y: p.y, date: p.date, value: p.value })}
            onMouseLeave={() => setTooltip(null)}
          >
            {/* Transparent enlarged hit area */}
            <circle cx={p.x} cy={p.y} r='12' fill='transparent' />
            {/* Visible dot */}
            <circle cx={p.x} cy={p.y} r='3.5' fill={color} />
          </g>
        ))}
      </svg>

      {tooltip && (
        <div
          className='pointer-events-none absolute z-10 whitespace-nowrap rounded-md border bg-white px-2 py-1 text-xs shadow-md'
          style={{
            left: `${(tooltip.x / width) * 100}%`,
            top: `${(tooltip.y / height) * 100}%`,
            transform:
              tooltip.y / height < 0.4
                ? 'translate(-50%, 16px)'
                : tooltip.x / width > 0.8
                  ? 'translate(-90%, -120%)'
                  : 'translate(-50%, -120%)',
          }}
        >
          <div className='font-medium text-gray-700'>{tooltip.date.slice(5)}</div>
          <div className='text-gray-500'>
            {tooltip.value} {t('dashboard.tasksCountSuffix')}
          </div>
        </div>
      )}
    </div>
  )
}
