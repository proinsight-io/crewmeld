import Link from 'next/link'

export default async function EmployeeSwaggerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const jsonUrl = `/api/public/employees/${id}/openapi`
  const endpoints = [
    ['GET', `/api/public/employees/${id}/status`, '测试 API Key'],
    ['POST', `/api/public/employees/${id}/conversations`, '创建会话'],
    [
      'POST',
      `/api/public/employees/${id}/conversations/{conversationId}/messages`,
      '发送消息（SSE）',
    ],
    ['POST', `/api/public/employees/${id}/conversations/{conversationId}/events`, '发送隐藏事件'],
    ['GET', `/api/public/employees/${id}/knowledge-bases`, '查询已绑定知识库'],
    [
      'GET',
      `/api/public/employees/${id}/knowledge-bases/{datasetId}/questions/top`,
      '查询 QA TopN 问题',
    ],
  ] as const
  return (
    <main className='min-h-screen bg-gray-50 p-8'>
      <div className='mx-auto max-w-6xl rounded-xl border bg-white p-6 shadow-sm'>
        <div className='mb-6 flex items-center justify-between'>
          <div>
            <h1 className='font-semibold text-2xl'>数字员工 Swagger API 文档</h1>
            <p className='mt-1 text-gray-500 text-sm'>所有业务接口使用 X-API-Key 请求头认证。</p>
          </div>
          <Link className='text-blue-600 text-sm underline' href={jsonUrl} target='_blank'>
            查看 OpenAPI JSON
          </Link>
        </div>
        <div className='overflow-hidden rounded-lg border'>
          {endpoints.map(([method, path, summary]) => (
            <div
              key={path}
              className='grid grid-cols-[72px_1fr_220px] items-center gap-3 border-b p-3 last:border-0'
            >
              <span
                className={`rounded px-2 py-1 text-center font-semibold text-xs ${method === 'GET' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}
              >
                {method}
              </span>
              <code className='break-all text-xs'>{path}</code>
              <span className='text-gray-600 text-sm'>{summary}</span>
            </div>
          ))}
        </div>
        <h2 className='mt-6 font-medium text-lg'>完整 OpenAPI 定义</h2>
        <iframe
          title='OpenAPI definition'
          src={jsonUrl}
          className='mt-3 h-[560px] w-full rounded border bg-gray-50'
        />
      </div>
    </main>
  )
}
