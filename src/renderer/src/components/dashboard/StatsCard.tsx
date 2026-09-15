import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface StatsCardProps {
  title: string
  value: string | number
  icon: LucideIcon
  trend?: {
    value: number
    label?: string
  }
  className?: string
}

export function StatsCard({ title, value, icon: Icon, trend, className }: StatsCardProps) {
  const getTrendIcon = () => {
    if (!trend) return null
    if (trend.value > 0) return <TrendingUp className="h-3 w-3" />
    if (trend.value < 0) return <TrendingDown className="h-3 w-3" />
    return <Minus className="h-3 w-3" />
  }

  const getTrendColor = () => {
    if (!trend) return ''
    if (trend.value > 0) return 'text-green-500'
    if (trend.value < 0) return 'text-red-500'
    return 'text-muted-foreground'
  }

  return (
    <Card hover className={cn('relay-metric', className)}>
      <CardHeader className="relay-metric-header">
        <div>
          <CardTitle className="relay-metric-label">{title}</CardTitle>
          <div className="relay-metric-value">{value}</div>
        </div>
        <div className="relay-metric-icon">
          <Icon className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent className="relay-metric-footer">
        {trend && (
          <div className={cn('relay-metric-trend', getTrendColor())}>
            {getTrendIcon()}
            <span className="ml-1">
              {trend.value > 0 ? '+' : ''}
              {trend.value}%
            </span>
            {trend.label && <span className="text-muted-foreground ml-1">{trend.label}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
