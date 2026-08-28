import { NextResponse } from 'next/server'

/** Return the OpenAPI 3.0 document for a published digital employee. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ employeeId: string }> }
) {
  const { employeeId } = await params
  const root = `/api/public/employees/${employeeId}`
  const security = [{ ApiKeyAuth: [] }]
  return NextResponse.json({
    openapi: '3.0.3',
    info: {
      title: 'CrewMeld 数字员工会话 API',
      description: '创建会话、发送消息、选择知识库、发送隐藏事件及查询常见问题。',
      version: '1.1.0',
    },
    paths: {
      [`${root}/status`]: {
        get: {
          summary: '测试 API Key',
          security,
          responses: { '200': { description: 'API Key 有效' }, '401': { description: '认证失败' } },
        },
      },
      [`${root}/conversations`]: {
        post: {
          summary: '创建数字员工会话',
          security,
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    externalUserId: { type: 'string' },
                    metadata: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: { '201': { description: '会话已创建，可能包含开场白' } },
        },
      },
      [`${root}/conversations/{conversationId}/messages`]: {
        post: {
          summary: '发送消息并接收 SSE 回复',
          security,
          parameters: [
            { name: 'conversationId', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'knowledgeBaseIds',
              in: 'query',
              description: '逗号分隔的 RAGFlow dataset ID；不传表示查询全部已绑定知识库。',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['content'],
                  properties: {
                    content: { type: 'string' },
                    knowledgeBaseIds: { type: 'array', items: { type: 'string' } },
                    serviceMode: { type: 'string', enum: ['ai', 'human_service'] },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'SSE stream' }, '401': { description: '认证失败' } },
        },
      },
      [`${root}/conversations/{conversationId}/events`]: {
        post: {
          summary: '发送不进入消息历史的事件',
          security,
          parameters: [
            { name: 'conversationId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['type'],
                  properties: {
                    type: { type: 'string', example: 'knowledge_base.selected' },
                    knowledgeBaseId: { type: 'string', description: 'RAGFlow dataset ID' },
                    topN: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
                    data: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: { '200': { description: '事件反馈，不持久化到消息历史' } },
        },
      },
      [`${root}/knowledge-bases`]: {
        get: {
          summary: '查询数字员工绑定的知识库',
          security,
          responses: { '200': { description: '知识库列表' } },
        },
      },
      [`${root}/knowledge-bases/{datasetId}/questions/top`]: {
        get: {
          summary: '查询指定 QA 知识库的 TopN 问题',
          security,
          parameters: [
            { name: 'datasetId', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'topN',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 3 },
            },
          ],
          responses: {
            '200': { description: '启用的常见问题列表' },
            '404': { description: '知识库未绑定或不是 QA 类型' },
          },
        },
      },
    },
    components: {
      securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    },
  })
}
