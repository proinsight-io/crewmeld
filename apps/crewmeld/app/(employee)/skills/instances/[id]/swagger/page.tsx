import Link from 'next/link'

interface SwaggerPageProps {
  params: Promise<{ id: string }>
}

/** Human-readable API documentation page for a published tool instance. */
export default async function SwaggerPage({ params }: SwaggerPageProps) {
  const { id } = await params
  const jsonUrl = `/api/employee/skills/instances/${id}/openapi`
  return (
    <main className='min-h-screen bg-gray-50 p-8'>
      <div className='mx-auto max-w-5xl rounded-xl border bg-white p-6 shadow-sm'>
        <div className='mb-6 flex items-center justify-between'>
          <div>
            <h1 className='font-semibold text-2xl'>Swagger API 文档</h1>
            <p className='mt-1 text-gray-500 text-sm'>已发布工具接口说明与调用格式</p>
          </div>
          <Link className='text-blue-600 text-sm underline' href={jsonUrl} target='_blank'>
            查看 OpenAPI JSON
          </Link>
        </div>
        <section className='rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm'>
          <p className='font-medium'>接口地址</p>
          <code className='mt-2 block break-all'>{`/api/tools/${id}/invoke`}</code>
          <p className='mt-3 font-medium'>认证方式</p>
          <code className='mt-2 block'>X-API-Key: {'<your-api-key>'}</code>
        </section>
        <section className='mt-6'>
          <h2 className='font-medium text-lg'>OpenAPI 定义</h2>
          <iframe
            title='OpenAPI definition'
            src={jsonUrl}
            className='mt-3 h-[560px] w-full rounded border bg-gray-50'
          />
        </section>
      </div>
    </main>
  )
}
