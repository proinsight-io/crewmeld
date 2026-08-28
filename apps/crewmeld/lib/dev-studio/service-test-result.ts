export interface ServiceSseEvent {
  event?: string
  data: string
  id?: string
  retry?: number
}

export interface ServiceTestMetadata {
  serviceType: 'json' | 'http' | 'sse'
  contentType?: string
  rawBody?: string
  previewUrl?: string
  previewExpiresAt?: string
  sseEvents?: ServiceSseEvent[]
  truncated?: boolean
}
