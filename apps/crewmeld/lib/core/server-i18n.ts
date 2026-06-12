/**
 * Server-side i18n — all backend user-facing strings
 *
 * Usage: import { t } from '@/lib/core/server-i18n'
 *        t('approvalRequest', 'en')  // '📋 Approval Request'
 *        t('approvalRequest')        // '📋 审批请求' (default zh)
 */

const messages = {
  // ── Approval cards ──
  approvalRequest: { zh: '📋 审批请求', en: '📋 Approval Request' },
  approvalDone: { zh: '📋 审批已处理', en: '📋 Approval Processed' },
  needsApproval: { zh: '需要审批', en: 'Needs Approval' },
  pendingContent: { zh: '待审批内容', en: 'Pending Content' },
  approvalContent: { zh: '审批内容', en: 'Approval Content' },
  approve: { zh: '通过', en: 'Approve' },
  reject: { zh: '驳回', en: 'Reject' },
  approved: { zh: '✅ 已通过', en: '✅ Approved' },
  rejected: { zh: '❌ 已驳回', en: '❌ Rejected' },
  approvedShort: { zh: '已通过', en: 'Approved' },
  rejectedShort: { zh: '已驳回', en: 'Rejected' },
  approvalApproved: { zh: '✅ 审批通过', en: '✅ Approved' },
  approvalRejected: { zh: '❌ 审批驳回', en: '❌ Rejected' },

  // ── Card field labels ──
  sender: { zh: '发起人', en: 'Initiated by' },
  sopProcess: { zh: '任务流程', en: 'Task' },
  currentStep: { zh: '当前步骤', en: 'Current Step' },
  step: { zh: '步骤', en: 'Step' },
  approvalNode: { zh: '审批节点', en: 'Approval Node' },
  result: { zh: '结果', en: 'Result' },
  handler: { zh: '处理人', en: 'Handled by' },
  handledAt: { zh: '处理时间', en: 'Handled at' },
  approver: { zh: '审批人', en: 'Approver' },
  deadline: { zh: '截止时间', en: 'Deadline' },
  aiSummary: { zh: 'AI 摘要', en: 'AI Summary' },
  summary: { zh: '摘要', en: 'Summary' },
  previousResult: { zh: '上一步结果', en: 'Previous Result' },
  status: { zh: '状态', en: 'Status' },
  progress: { zh: '进度', en: 'Progress' },

  // ── Truncation ──
  truncated: { zh: '\n...(内容已截断)', en: '\n...(content truncated)' },
  outputTruncated: { zh: '\n...(输出已截断)', en: '\n...(output truncated)' },

  // ── Email ──
  emailSender: { zh: 'CrewMeld 通知', en: 'CrewMeld Notification' },
  emailSubject: { zh: '[待确认]', en: '[Pending]' },
  emailHeader: { zh: 'CrewMeld · 审批通知', en: 'CrewMeld · Approval Notification' },
  emailGreeting: { zh: '您有一条待确认的任务', en: 'You have a pending approval task' },
  emailTaskLabel: { zh: '任务流程', en: 'Task' },
  emailNodeLabel: { zh: '任务节点', en: 'Task Node' },
  emailPrevResult: { zh: '上一步执行结果', en: 'Previous step result' },
  emailFooter: {
    zh: '此邮件由 CrewMeld 自动发送，请勿直接回复。',
    en: 'This email was sent automatically by CrewMeld. Please do not reply directly.',
  },
  emailInstruction: {
    zh: '点击上方按钮将跳转到审批确认页面。若按钮无法点击，请复制以下链接到浏览器打开：',
    en: 'Click the button above to go to the approval page. If the button does not work, copy the link below into your browser:',
  },
  imagePlaceholder: { zh: '[图片: $1]', en: '[Image: $1]' },

  // ── Conversation engine ──
  thinking: { zh: '思考中...', en: 'Thinking...' },
  queryingKnowledge: { zh: '正在查询知识库...', en: 'Querying knowledge base...' },
  generating: { zh: '正在生成回复...', en: 'Generating response...' },
  expiredHint: {
    zh: '[历史工具结果已过期，请重新调用工具获取最新数据]',
    en: '[Historical tool result expired, please call the tool again for latest data]',
  },
  conversationNotFound: { zh: '对话不存在', en: 'Conversation not found' },
  conversationClosed: { zh: '对话已关闭', en: 'Conversation is closed' },
  employeeNotFound: { zh: '关联的数字员工不存在', en: 'Associated digital employee not found' },
  executionSuccess: { zh: '执行成功，无输出内容', en: 'Execution succeeded, no output' },
  executionDone: { zh: '执行完成', en: 'Execution completed' },
  toolRoundExceeded: { zh: '工具调用轮次超限', en: 'Tool call rounds exceeded' },
  emptyLLMResponse: { zh: 'LLM 返回空响应体', en: 'LLM returned empty response' },
  unknownError: { zh: '未知错误', en: 'Unknown error' },
  conversationDone: { zh: '对话回复完成', en: 'Conversation reply completed' },
  missingExecutionId: {
    zh: '缺少 execution_id 参数，请从对话历史中获取之前触发 SOP 时返回的执行编号',
    en: 'Missing execution_id parameter, please get the execution ID from the previous SOP trigger result in conversation history',
  },
  fileGenerated: { zh: '已生成文件', en: 'Files generated' },
  fileNote: {
    zh: '文件将自动发送给用户，请勿在回复中包含文件下载链接或 base64 内容',
    en: 'Files will be sent to the user automatically, do not include file download links or base64 content in your reply',
  },
  toolCallFailed: { zh: '工具执行失败', en: 'Tool execution failed' },
  toolCallSuccess: { zh: '成功', en: 'succeeded' },
  toolCallFailedShort: { zh: '失败', en: 'failed' },
  toolCallError: { zh: '工具 "{name}" 报错：{error}', en: 'Tool "{name}" error: {error}' },

  // ── SOP task tool results ──
  taskSkipped: {
    zh: '[任务调用被跳过] 本轮已触发了一个任务，不能同时执行多个。请等待当前任务完成后再决定是否需要调用其他任务。',
    en: '[Task skipped] A task has already been triggered this round. Please wait for the current task to complete before calling another.',
  },
  taskAlreadyTriggered: {
    zh: '[任务已触发] 该任务已在本轮对话中触发过，请勿重复调用。请直接根据之前的执行结果回复用户。',
    en: '[Task already triggered] This task was already triggered in this conversation round. Please reply based on the previous result.',
  },
  taskRecentlyExecuted: {
    zh: '[任务已执行] 该任务在 5 分钟内已经执行过且结果仍然有效。请从对话历史中找到上一次该工具的执行结果，直接将结果原样整理后回复用户，不要告诉用户"已经执行过"或"重复请求"等信息。',
    en: '[Task already executed] This task was executed within the last 5 minutes and the result is still valid. Find the previous result in conversation history and present it to the user as-is, without mentioning it was a repeated request.',
  },
  taskStartFailed: { zh: '任务启动失败', en: 'Task failed to start' },
  taskCompleted: {
    zh: '[任务执行完成] 任务「{name}」已成功执行（编号：{id}）。以下是执行结果，请直接整理后回复用户，不要再次调用任何工具：',
    en: '[Task completed] Task "{name}" has been executed successfully (ID: {id}). Here are the results, please summarize and reply to the user without calling any tools again:',
  },
  taskCompletedNoOutput: {
    zh: '[任务执行完成] 任务「{name}」已执行完成（编号：{id}），但未产生输出内容。请告知用户执行已完成，不要再次调用此工具。',
    en: '[Task completed] Task "{name}" has been executed (ID: {id}), but produced no output. Please inform the user that the task is complete.',
  },
  taskStarted: {
    zh: '[任务已启动] 任务「{name}」已启动，正在异步执行中（编号：{id}）。请告知用户已启动并提供执行编号，不要再次调用此工具。',
    en: '[Task started] Task "{name}" has been started and is running asynchronously (ID: {id}). Please inform the user and provide the execution ID.',
  },
  executingTool: { zh: '正在执行{name}...', en: 'Executing {name}...' },
  executedTool: { zh: '{name}执行完成', en: '{name} completed' },
  sopLabel: { zh: '标准操作流程', en: 'Standard Operating Procedure' },
  executingTask: { zh: '正在执行任务「{name}」...', en: 'Executing task "{name}"...' },
  taskRunning: { zh: '任务正在执行中...', en: 'Task is running...' },
  taskAwaitingConfirmation: {
    zh: '任务正在等待人工确认...',
    en: 'Task is awaiting manual confirmation...',
  },
  taskQueued: { zh: '任务正在排队等待执行...', en: 'Task is queued for execution...' },

  // ── SOP completion notification ──
  sopCompleted: { zh: '任务「{name}」已执行完成。', en: 'Task "{name}" has been completed.' },
  sopFailed: { zh: '任务「{name}」执行失败。', en: 'Task "{name}" failed.' },
  sopStatus: { zh: '任务「{name}」执行状态: {status}', en: 'Task "{name}" status: {status}' },
  sopReason: { zh: '原因', en: 'Reason' },
  sopEmailCompleted: { zh: '任务「{name}」执行完成', en: 'Task "{name}" completed' },

  // ── SOP engine ──
  sopNoStartNode: { zh: 'SOP 无起始节点', en: 'SOP has no start node' },
  approvalRecordLost: { zh: '审批记录丢失，无法恢复', en: 'Approval record lost, cannot recover' },
  approvalComment: { zh: '审批意见', en: 'Comment' },
  errSopTaskTimeout: {
    zh: '任务执行超时（{minutes} 分钟），已自动终止',
    en: 'Task execution timed out ({minutes} min), auto-terminated',
  },
  errSopTaskTimeoutNoRetry: {
    zh: '任务执行超时（{minutes} 分钟），不重试',
    en: 'Task execution timed out ({minutes} min), no retry',
  },
  errSopNodeNotFound: { zh: '节点未找到：{nodeId}', en: 'Node not found: {nodeId}' },
  errSopRejectionLimit: {
    zh: '拒绝次数已达上限（{max}）',
    en: 'Rejection count reached limit ({max})',
  },
  errSopMaxRetriesExceeded: {
    zh: '冷恢复后已达最大重试次数',
    en: 'Max retries exceeded after cold recovery',
  },
  errSopApprovalPreValFailed: {
    zh: '审批预校验失败：{reason}',
    en: 'Approval pre-validation failed: {reason}',
  },

  // ── Webhook handler ──
  signatureVerifyFailed: { zh: '签名验证失败', en: 'Signature verification failed' },
  processError: { zh: '处理消息时出错', en: 'Error processing message' },
  tgHello: { zh: '你好', en: 'Hello' },
  tgGreeting: {
    zh: '你的 Telegram User ID 是：',
    en: 'Your Telegram User ID is:',
  },
  tgInstruction: {
    zh: '请将此 ID 填写到数字员工管理台「协作人员」的 Telegram 联系方式中，即可接收审批通知。',
    en: 'Please enter this ID in the "Collaborators" section of the digital employee dashboard under Telegram contact to receive approval notifications.',
  },
  wxoaUserPrefix: { zh: '公众号用户', en: 'Official Account User' },
  replyTitle: { zh: '回复', en: 'Reply' },

  // ── Notification dispatcher ──
  emailSendFailed: { zh: '邮件发送失败', en: 'Email sending failed' },
  noEmailConnection: { zh: '无可用的邮件系统连接', en: 'No email system connection available' },
  emailConfigIncomplete: { zh: '邮件连接配置不完整', en: 'Email connection config incomplete' },
  emailSent: { zh: '审批确认邮件已发送', en: 'Approval confirmation email sent' },
  noWecomConnection: { zh: '无可用的企微系统连接', en: 'No WeCom system connection available' },
  wecomConfigIncomplete: { zh: '企微连接配置不完整', en: 'WeCom connection config incomplete' },
  wecomCardSent: { zh: '企微审批卡片已发送', en: 'WeCom approval card sent' },
  pendingNode: { zh: '待确认节点', en: 'Pending Node' },

  // ── Approval decision notification ──
  approvalLabel: { zh: '审批', en: 'Approval' },
  approvalDecisionSubject: { zh: '审批{decision}', en: 'Approval {decision}' },
  approvalDecisionResult: {
    zh: 'SOP「{name}」审批结果：{decision}',
    en: 'SOP "{name}" approval result: {decision}',
  },

  // ── Channel API errors ──
  unauthorized: { zh: '未授权', en: 'Unauthorized' },
  channelNotFound: { zh: '渠道不存在', en: 'Channel not found' },
  channelListFailed: { zh: '获取渠道列表失败', en: 'Failed to get channel list' },
  channelDetailFailed: { zh: '获取渠道详情失败', en: 'Failed to get channel details' },
  channelCreateFailed: { zh: '创建渠道失败', en: 'Failed to create channel' },
  channelUpdateFailed: { zh: '更新渠道失败', en: 'Failed to update channel' },
  channelDeleteFailed: { zh: '删除渠道失败', en: 'Failed to delete channel' },
  channelTestFailed: { zh: '渠道测试失败', en: 'Channel test failed' },
  channelDecryptFailed: { zh: '解密配置失败', en: 'Failed to decrypt config' },
  channelMissingFields: {
    zh: '缺少必填字段: name, type, config',
    en: 'Missing required fields: name, type, config',
  },
  channelUnsupportedType: {
    zh: '不支持的渠道类型: {type}',
    en: 'Unsupported channel type: {type}',
  },
  channelWecomRequired: {
    zh: '企微渠道必须提供 corpId, corpSecret, agentId',
    en: 'WeCom channel requires corpId, corpSecret, agentId',
  },
  channelParamsIncomplete: { zh: '参数不完整', en: 'Incomplete parameters' },
  missingEmployeeId: { zh: '缺少 employeeId', en: 'Missing employeeId' },
  missingConnectionId: { zh: '缺少 connectionId', en: 'Missing connectionId' },
  dingtalkNotConfigured: { zh: '未配置钉钉参数', en: 'DingTalk not configured' },
  dingtalkNotBound: {
    zh: '钉钉连接未绑定数字员工',
    en: 'DingTalk connection not bound to digital employee',
  },
  discordNotConfigured: { zh: '未配置 Discord 参数', en: 'Discord not configured' },
  discordNotBound: {
    zh: 'Discord 连接未绑定数字员工',
    en: 'Discord connection not bound to digital employee',
  },
  wecomNotConfigured: { zh: '未配置企微参数', en: 'WeCom not configured' },
  wxoaNotConfigured: { zh: '未配置公众号参数', en: 'WeChat Official Account not configured' },
  telegramNotConfigured: { zh: '未配置 Telegram 参数', en: 'Telegram not configured' },
  decryptionFailed: { zh: '解密失败', en: 'Decryption failed' },
  internalError: { zh: '内部错误', en: 'Internal error' },

  // ── Approval page ──
  approvalPageMissingToken: { zh: '缺少审批令牌', en: 'Missing approval token' },
  approvalPageInvalidLink: { zh: '审批链接无效', en: 'Invalid approval link' },
  approvalPageAlreadyProcessed: {
    zh: '该审批已被处理',
    en: 'This approval has already been processed',
  },
  approvalPageExpired: { zh: '审批链接已过期', en: 'Approval link has expired' },
  approvalPageDefaultSop: { zh: 'SOP 流程', en: 'SOP Workflow' },
  approvalPageCannotApprove: { zh: '无法审批', en: 'Cannot Approve' },
  approvalPageDone: { zh: '审批完成', en: 'Approval Completed' },
  approvalPageDoneHint: {
    zh: '您已选择「{decision}」，可以关闭此页面。',
    en: 'You have selected "{decision}". You may close this page.',
  },
  approvalPageConflict: { zh: '已被处理', en: 'Already Processed' },
  approvalPageConflictHint: {
    zh: '该审批已被其他人处理，无需重复操作。',
    en: 'This approval has been processed by someone else. No further action is needed.',
  },
  approvalPageApprove: { zh: '同意', en: 'Approve' },
  approvalPageReject: { zh: '不同意', en: 'Reject' },
  approvalPageNode: { zh: '审批节点', en: 'Approval Node' },
  approvalPageDeadline: { zh: '截止时间', en: 'Deadline' },
  approvalPagePreselectedHint: {
    zh: '您选择了「{decision}」，请确认并提交。如需更改可点击下方另一个按钮。',
    en: 'You selected "{decision}". Please confirm and submit. To change, click the other button below.',
  },
  approvalPageCommentLabel: { zh: '审批意见', en: 'Comment' },
  approvalPageCommentPlaceholder: {
    zh: '请输入审批意见（可选）',
    en: 'Enter your comment (optional)',
  },
  approvalPageSender: { zh: '申请人', en: 'Requester' },
  approvalPageFromChannel: { zh: '来自{channel}', en: 'via {channel}' },
  approvalPageOperationFailed: { zh: '操作失败', en: 'Operation failed' },
  approvalPageNetworkError: { zh: '网络错误，请重试', en: 'Network error, please try again' },
  approvalPageSubmitting: { zh: '提交中...', en: 'Submitting...' },
  approvalPageConfirm: { zh: '确认{decision}', en: 'Confirm {decision}' },
  channelWeb: { zh: '网页', en: 'Web' },
  channelDingtalk: { zh: '钉钉', en: 'DingTalk' },
  channelFeishu: { zh: '飞书', en: 'Feishu' },
  channelWecom: { zh: '企业微信', en: 'WeCom' },

  // ── LLM summarizer ──
  summarizePrompt: {
    zh: '你是一个信息摘要助手。请将下面的 JSON 数据用简洁的中文自然语言概括，直接输出结果，不要包含任何 JSON 格式、代码块或技术术语。重点提取对用户有价值的信息。',
    en: 'You are a summary assistant. Please summarize the following JSON data in concise English. Output the result directly without any JSON format, code blocks, or technical jargon. Focus on extracting information valuable to the user.',
  },

  // ── Auth / RBAC ──
  authNotLoggedIn: { zh: '未登录', en: 'Not logged in' },
  authUnauthorized: { zh: '未授权', en: 'Unauthorized' },
  authAccountDisabled: { zh: '账号已被禁用', en: 'Account has been disabled' },
  authUserNotFound: { zh: '用户不存在', en: 'User not found' },
  authInsufficientRole: {
    zh: '权限不足，需要{role}权限',
    en: 'Insufficient permission, {role} role required',
  },
  authInsufficientPermission: { zh: '权限不足', en: 'Insufficient permission' },
  authRoleSuperAdmin: { zh: '超级管理员', en: 'Super Admin' },
  authRoleAdmin: { zh: '管理员', en: 'Admin' },
  authRoleMember: { zh: '普通用户', en: 'Member' },
  authRegistrationClosed: {
    zh: '注册已关闭，请联系管理员。',
    en: 'Registration is closed. Please contact the administrator.',
  },
  authPendingApproval: {
    zh: '账号正在等待管理员审批，请耐心等候。',
    en: 'Your account is pending admin approval. Please wait.',
  },
  authApprovalRejected: {
    zh: '账号申请已被拒绝，请联系管理员。',
    en: 'Your account application was rejected. Please contact the administrator.',
  },
  authNeedSuperAdmin: { zh: '需要超级用户权限', en: 'Super admin permission required' },

  // ── Auth / SSO ──
  authSsoDingtalkFailed: { zh: '钉钉授权失败', en: 'DingTalk authorization failed' },
  authSsoDingtalkUserFailed: { zh: '获取钉钉用户信息失败', en: 'Failed to get DingTalk user info' },
  authSsoFeishuFailed: { zh: '飞书授权失败', en: 'Feishu authorization failed' },
  authSsoFeishuUserFailed: { zh: '获取飞书用户信息失败', en: 'Failed to get Feishu user info' },
  authSsoWecomFailed: { zh: '企业微信授权失败', en: 'WeCom authorization failed' },
  authSsoWecomUserFailed: {
    zh: '获取企业微信用户身份失败',
    en: 'Failed to get WeCom user identity',
  },
  authSsoWecomNeedCorpId: {
    zh: '企业微信 SSO 需要 corpId（通过 SystemConnection 传入）',
    en: 'WeCom SSO requires corpId (via SystemConnection)',
  },
  authSsoWecomDetailFailed: {
    zh: '获取企业微信用户详情失败',
    en: 'Failed to get WeCom user details',
  },
  authSsoLdapConnFailed: { zh: 'LDAP 连接失败', en: 'LDAP connection failed' },
  authSsoLdapAdminFailed: { zh: '管理员认证失败', en: 'Admin authentication failed' },
  authSsoLdapSearchFailed: { zh: '用户搜索失败', en: 'User search failed' },
  authSsoLdapSearchError: { zh: '搜索异常', en: 'Search error' },
  authSsoLdapUserNotFound: { zh: '用户不存在', en: 'User not found' },
  authSsoLdapInvalidCred: { zh: '用户名或密码错误', en: 'Invalid username or password' },
  authSsoUnknownType: { zh: '未知 SSO 类型: {type}', en: 'Unknown SSO type: {type}' },
  authSsoEnvMissing: {
    zh: '{env} 环境变量未配置，无法安全{action}',
    en: '{env} environment variable not configured, cannot safely {action}',
  },
  authSsoUnsupportedMethod: {
    zh: '不支持的登录方式: {method}',
    en: 'Unsupported login method: {method}',
  },
  authSsoProviderDisabled: { zh: '该登录方式未启用', en: 'This login method is not enabled' },
  authSsoAuthorizeFailed: { zh: '授权发起失败', en: 'Authorization initiation failed' },
  authSsoCallbackCancelled: { zh: '授权被取消', en: 'Authorization cancelled' },
  authSsoCallbackMissingParams: { zh: '缺少授权参数', en: 'Missing authorization parameters' },
  authSsoCallbackVerifyFailed: { zh: '验证失败', en: 'Verification failed' },
  authSsoCallbackConfigLost: { zh: '配置信息丢失', en: 'Configuration lost' },
  authSsoCallbackConfigDisabled: { zh: '配置已被禁用', en: 'Configuration has been disabled' },
  authSsoLoginFailed: { zh: '登录失败', en: 'Login failed' },
  authSsoConfigNotFound: { zh: '配置不存在', en: 'Configuration not found' },
  authSsoUpdateFailed: { zh: '更新配置失败', en: 'Failed to update configuration' },
  authSsoDeleteFailed: { zh: '删除配置失败', en: 'Failed to delete configuration' },
  authSsoGetFailed: { zh: '获取配置失败', en: 'Failed to get configuration' },
  authSsoCreateFailed: { zh: '创建配置失败', en: 'Failed to create configuration' },
  authSsoMissingFields: { zh: '缺少必填字段：{fields}', en: 'Missing required fields: {fields}' },
  authSsoInvalidProvider: { zh: '无效的 provider: {provider}', en: 'Invalid provider: {provider}' },
  authSsoEnterpriseLogin: { zh: '企业账号登录', en: 'Enterprise Login' },
  authSsoRateLimited: {
    zh: '登录尝试过于频繁，请稍后再试',
    en: 'Too many login attempts, please try again later',
  },
  authSsoEnterCredentials: { zh: '请输入用户名和密码', en: 'Please enter username and password' },
  authSsoLdapNotEnabled: { zh: 'LDAP 未启用', en: 'LDAP is not enabled' },
  authSsoLdapConfigIncomplete: { zh: 'LDAP 配置不完整', en: 'LDAP configuration is incomplete' },
  authSsoLdapConnFailed2: { zh: 'LDAP 连接失败: {error}', en: 'LDAP connection failed: {error}' },

  // ── Audit ──
  auditMethodCreate: { zh: '创建', en: 'Create' },
  auditMethodUpdate: { zh: '更新', en: 'Update' },
  auditMethodDelete: { zh: '删除', en: 'Delete' },
  auditResEmployee: { zh: '数字员工', en: 'Digital Employee' },
  auditResHumanEmployee: { zh: '真人员工', en: 'Human Employee' },
  auditResConversation: { zh: '对话', en: 'Conversation' },
  auditResChannel: { zh: '渠道', en: 'Channel' },
  auditResConnector: { zh: '连接器', en: 'Connector' },
  auditResModelConfig: { zh: '模型配置', en: 'Model Config' },
  auditResSop: { zh: 'SOP流程', en: 'SOP' },
  auditResScheduledTask: { zh: '定时任务', en: 'Scheduled Task' },
  auditResTask: { zh: '任务', en: 'Task' },
  auditResTemplate: { zh: '模板', en: 'Template' },
  auditResSkill: { zh: '技能', en: 'Skill' },
  auditResKnowledge: { zh: '知识库', en: 'Knowledge Base' },
  auditResWorkflow: { zh: '工作流', en: 'Workflow' },
  auditResSystemConfig: { zh: '系统配置', en: 'System Config' },
  auditResUserManagement: { zh: '用户', en: 'User' },
  auditResTool: { zh: '工具', en: 'Tool' },
  auditResIntegration: { zh: '集成', en: 'Integration' },
  auditResWorkshop: { zh: '工坊', en: 'Workshop' },
  auditResRole: { zh: '角色', en: 'Role' },
  auditActCreated: { zh: '创建', en: 'Created' },
  auditActUpdated: { zh: '更新', en: 'Updated' },
  auditActDeleted: { zh: '删除', en: 'Deleted' },
  auditActStatusChanged: { zh: '变更状态', en: 'Status Changed' },
  auditActToggled: { zh: '切换', en: 'Toggled' },
  auditActApproved: { zh: '审批通过', en: 'Approved' },
  auditActRejected: { zh: '审批拒绝', en: 'Rejected' },
  auditActCancelled: { zh: '取消', en: 'Cancelled' },
  auditActExecuted: { zh: '执行', en: 'Executed' },
  auditActTested: { zh: '测试', en: 'Tested' },
  auditActTestRun: { zh: '试运行', en: 'Test Run' },
  auditActHealthCheck: { zh: '健康检查', en: 'Health Check' },
  auditActDeployed: { zh: '部署', en: 'Deployed' },
  auditActInstantiated: { zh: '实例化', en: 'Instantiated' },
  auditActImported: { zh: '导入', en: 'Imported' },
  auditActExported: { zh: '导出', en: 'Exported' },
  auditActDecided: { zh: '人工决策', en: 'Manual Decision' },
  auditActQuickDecided: { zh: '快速决策', en: 'Quick Decision' },
  auditActMessageSent: { zh: '发送消息', en: 'Message Sent' },
  auditActNotificationBot: { zh: '配置通知机器人', en: 'Configure Notification Bot' },
  auditActBound: { zh: '绑定', en: 'Bound' },
  auditActUnbound: { zh: '解绑', en: 'Unbound' },
  auditActConnected: { zh: '连接', en: 'Connected' },
  auditActDisconnected: { zh: '断开', en: 'Disconnected' },
  auditActParsed: { zh: '解析', en: 'Parsed' },
  auditActUploaded: { zh: '上传', en: 'Uploaded' },
  auditActValidated: { zh: '验证', en: 'Validated' },
  auditActInvoked: { zh: '调用', en: 'Invoked' },
  auditActChatted: { zh: '对话测试', en: 'Chat Test' },
  auditActGenerated: { zh: '生成', en: 'Generated' },
  auditActCustomRoleCreated: { zh: '创建自定义角色', en: 'Custom Role Created' },
  auditSystemUser: { zh: '系统', en: 'System' },
  auditSummaryTemplate: {
    zh: '{action}了{resource}「{name}」',
    en: '{action} {resource} "{name}"',
  },

  // ── Connector tests ──
  connTestFieldsRequired: { zh: '{fields} 为必填项', en: '{fields} are required' },
  connTestSucceeded: { zh: '{name}连接测试成功', en: '{name} connection test succeeded' },
  connTestFailed: { zh: '{name}连接失败: {error}', en: '{name} connection failed: {error}' },
  connTestFailedShort: { zh: '连接失败', en: 'Connection failed' },
  connTestUnsupportedType: {
    zh: '不支持的连接类型: {type}',
    en: 'Unsupported connection type: {type}',
  },
  connTestUnknownError: { zh: '连接测试发生未知错误', en: 'Unknown error during connection test' },
  connTestTcpSuccess: {
    zh: '{label} 端口连通测试成功（TCP {addr}）',
    en: '{label} port connectivity test succeeded (TCP {addr})',
  },
  connTestTcpNote: {
    zh: '仅验证端口连通性，未验证认证',
    en: 'Port connectivity only, authentication not verified',
  },
  connTestTcpTimeout: {
    zh: '{label} 连接超时（TCP {addr}）',
    en: '{label} connection timed out (TCP {addr})',
  },
  connTestRequestSuccess: { zh: '请求成功 — {status}', en: 'Request succeeded — {status}' },
  connTestRequestFailed: { zh: '请求失败 — {status}', en: 'Request failed — {status}' },
  connTestNoTags: { zh: '无', en: 'None' },
  connTestNoDescription: { zh: '无描述', en: 'No description' },
  connTestOpenClawSkills: {
    zh: '{name} 连接成功（{count} 个 Skills 可用）',
    en: '{name} connected ({count} Skills available)',
  },
  connTestVersionUnknown: { zh: '未知', en: 'Unknown' },
  connTestGatewayUnreachable: { zh: 'Gateway 不可达', en: 'Gateway unreachable' },
  connTestDifyUnreachable: { zh: 'Dify 不可达', en: 'Dify unreachable' },
  connTestTelegramInvalid: { zh: 'Telegram Bot Token 无效', en: 'Telegram Bot Token is invalid' },
  connTestCannotReadBody: { zh: '(无法读取响应体)', en: '(unable to read response body)' },
  connTestTelegramVerifyFailed: {
    zh: 'Telegram Bot 验证失败: HTTP {status} — {body}',
    en: 'Telegram Bot verification failed: HTTP {status} — {body}',
  },
  connTestTimeoutHint: {
    zh: '（请求超时，请检查网络是否可访问 {host}）',
    en: '(Request timed out, please check network access to {host})',
  },
  connTestNetworkHint: {
    zh: '（网络错误 {code}，请检查 DNS 解析及网络设置）',
    en: '(Network error {code}, check DNS and network settings)',
  },
  connTestFetchHint: {
    zh: '（fetch 失败，可能是网络不通或 TLS 握手失败）',
    en: '(fetch failed, possibly due to network issue or TLS handshake failure)',
  },
  connTestSmsTencent: { zh: '腾讯云', en: 'Tencent Cloud' },
  connTestSmsAliyun: { zh: '阿里云', en: 'Alibaba Cloud' },
  connTestSmsSuccess: {
    zh: '短信连接测试成功（{provider}）',
    en: 'SMS connection test succeeded ({provider})',
  },
  connTestEmailSuccess: { zh: '邮件连接测试成功', en: 'Email connection test succeeded' },
  connTestKnowledgeUnreachable: { zh: '知识库不可达', en: 'Knowledge base unreachable' },
  connTestDirectConnect: { zh: '(直连)', en: '(direct)' },
  connTestConnString: { zh: '(连接串)', en: '(connection string)' },
  connTestWxoaSuccess: {
    zh: '微信公众号连接测试成功',
    en: 'WeChat Official Account connection test succeeded',
  },
  connTestWxoaFailed: {
    zh: '微信公众号连接测试失败: {error}',
    en: 'WeChat Official Account connection test failed: {error}',
  },
  connHealthUnknown: { zh: '未知错误', en: 'Unknown error' },

  // ── Connector type labels (server-side) ──
  connTypeWecom: { zh: '企业微信', en: 'WeCom' },
  connTypeDingtalk: { zh: '钉钉', en: 'DingTalk' },
  connTypeFeishu: { zh: '飞书', en: 'Feishu' },
  connTypeCrm: { zh: 'CRM 系统', en: 'CRM System' },
  connTypeDatabase: { zh: '数据库', en: 'Database' },
  connTypeCustomApi: { zh: '自定义 API', en: 'Custom API' },
  connTypeEmail: { zh: '邮件', en: 'Email' },
  connTypeSms: { zh: '短信', en: 'SMS' },
  connTypeRagflow: { zh: '知识库', en: 'Knowledge Base' },
  connTypeWxoa: { zh: '微信公众号', en: 'WeChat Official Account' },

  // ── SOP status labels ──
  sopStatusPending: { zh: '等待中', en: 'Pending' },
  sopStatusRunning: { zh: '执行中', en: 'Running' },
  sopStatusPausedForHuman: { zh: '等待人工确认', en: 'Awaiting Manual Confirmation' },
  sopStatusCompleted: { zh: '已完成', en: 'Completed' },
  sopStatusTimedOut: { zh: '已超时', en: 'Timed Out' },
  sopStatusError: { zh: '执行出错', en: 'Error' },
  sopStatusFailed: { zh: '执行失败', en: 'Failed' },
  sopStatusCancelled: { zh: '已取消', en: 'Cancelled' },
  sopNodeStatusPending: { zh: '等待中', en: 'Pending' },
  sopNodeStatusRunning: { zh: '执行中', en: 'Running' },
  sopNodeStatusCompleted: { zh: '已完成', en: 'Completed' },
  sopNodeStatusSkipped: { zh: '已跳过', en: 'Skipped' },
  sopNodeStatusError: { zh: '出错', en: 'Error' },
  sopExecutionNotFound: {
    zh: '未找到执行编号为 {id} 的 SOP 记录',
    en: 'SOP execution record with ID {id} not found',
  },
  sopUnknown: { zh: '未知 SOP', en: 'Unknown SOP' },

  // ── SOP engine ──
  sopValidatorNoNodes: { zh: 'SOP「{name}」中没有任何节点', en: 'SOP "{name}" has no nodes' },
  sopValidatorNoConnection: {
    zh: '节点「{name}」没有任何连接',
    en: 'Node "{name}" has no connections',
  },
  sopValidatorNoEmployee: { zh: '未选择数字员工', en: 'No digital employee selected' },
  sopValidatorEmployeeNotFound: {
    zh: '关联的数字员工不存在',
    en: 'Associated digital employee not found',
  },
  sopValidatorNoKnowledgeOrTool: {
    zh: '该数字员工未绑定知识库，请至少选择一个可调用工具',
    en: 'This digital employee has no knowledge base bound, please select at least one callable tool',
  },
  sopValidatorToolNotDeployed: {
    zh: '以下工具未部署或不存在：{tools}',
    en: 'The following tools are not deployed or do not exist: {tools}',
  },
  sopValidatorNoHuman: { zh: '未选择协作人员', en: 'No collaborator selected' },
  sopValidatorHumanNotFound: {
    zh: '关联的协作人员不存在',
    en: 'Associated collaborator not found',
  },
  sopValidatorHumanNoContact: {
    zh: '协作人员「{name}」未配置联系方式',
    en: 'Collaborator "{name}" has no contact method configured',
  },
  sopValidatorNoNotifyMethod: { zh: '未选择通知方式', en: 'No notification method selected' },
  sopNodeTypeEmployee: { zh: '数字员工', en: 'Digital Employee' },
  sopNodeTypeHuman: { zh: '协作人员', en: 'Collaborator' },
  sopNodeTypeHumanConfirm: { zh: '人工确认', en: 'Manual Confirmation' },
  sopNodeTypeBranch: { zh: '多路分支', en: 'Multi-Branch' },
  sopApprovalTimeout: { zh: '审批超时', en: 'Approval timed out' },
  sopNodeApprovalTimeout: { zh: '节点 {node} 审批超时', en: 'Node {node} approval timed out' },
  sopLevelTimeout: { zh: '{level}级超时', en: 'Level {level} timeout' },
  sopCheckDegradeFallback: { zh: '校验降级放行', en: 'Validation degraded, allowing pass' },
  sopCallTool: { zh: '调用工具：{name}', en: 'Calling tool: {name}' },
  sopToolInput: { zh: '工具输入参数', en: 'Tool input parameters' },
  sopExecuteTask: { zh: '执行任务', en: 'Execute task' },
  sopStartExecution: { zh: '开始执行：{name}节点任务', en: 'Starting execution: {name} node task' },
  sopToolCallSuccess: { zh: '调用工具「{name}」成功', en: 'Tool "{name}" called successfully' },
  sopToolCallFailed: { zh: '调用工具「{name}」失败', en: 'Tool "{name}" call failed' },
  sopToolRetrySuccess: { zh: '补调工具「{name}」成功', en: 'Retry tool "{name}" succeeded' },
  sopToolRetryFailed: { zh: '补调工具「{name}」失败', en: 'Retry tool "{name}" failed' },
  sopExecFailed: { zh: '执行失败：{error}', en: 'Execution failed: {error}' },
  sopExecCompleted: { zh: '执行完成：{result}', en: 'Execution completed: {result}' },
  sopExecCompletedShort: { zh: '执行完成', en: 'Execution completed' },
  sopUnknownLabel: { zh: '未知', en: 'Unknown' },
  sopMissingInfo: { zh: '未提供', en: 'Not provided' },
  sopSelectBranch: {
    zh: '选择{type}分支{index}编号{id}：{desc}',
    en: 'Selected {type} branch {index} ID {id}: {desc}',
  },
  sopFileGenerated: {
    zh: '已生成文件{files}，文件将自动发送给用户，无需在回复中包含文件内容或下载链接',
    en: 'Files generated: {files}. Files will be sent automatically, do not include file content or download links in the reply',
  },
  sopAttachment: { zh: '附件', en: 'Attachment' },
  sopNotExistOrDisabled: {
    zh: 'SOP 不存在或已停用',
    en: 'SOP does not exist or has been disabled',
  },
  sopValidationFailed: {
    zh: '校验不通过，无法执行：{errors}',
    en: 'Validation failed, cannot execute: {errors}',
  },
  sopStartFailed: { zh: '启动 SOP 失败: {error}', en: 'Failed to start SOP: {error}' },
  sopTriggerFailed: { zh: '触发 SOP 执行失败', en: 'Failed to trigger SOP execution' },
  sopCancelFailed: {
    zh: '取消失败（执行已终结或不存在）',
    en: 'Cancel failed (execution already finished or does not exist)',
  },
  sopCancelError: { zh: '取消 SOP 执行失败', en: 'Failed to cancel SOP execution' },
  sopExecNotFound: { zh: '执行记录不存在', en: 'Execution record not found' },
  sopGetDetailFailed: { zh: '获取执行详情失败', en: 'Failed to get execution details' },
  sopGetListFailed: { zh: '获取执行记录列表失败', en: 'Failed to get execution record list' },
  sopNotFound: { zh: 'SOP 不存在', en: 'SOP not found' },
  sopGetFailed: { zh: '获取 SOP 详情失败', en: 'Failed to get SOP details' },
  sopUpdateFailed: { zh: '更新 SOP 失败', en: 'Failed to update SOP' },
  sopDeleteFailed: { zh: '删除 SOP 失败', en: 'Failed to delete SOP' },
  sopApprovalInvalid: { zh: '审批链接无效或已过期', en: 'Approval link is invalid or expired' },
  sopApprovalMismatch: {
    zh: '审批链接与当前审批不匹配',
    en: 'Approval link does not match current approval',
  },
  sopApprovalInvalidDecision: {
    zh: '无效的决策值，必须为 approve 或 reject',
    en: 'Invalid decision value, must be approve or reject',
  },
  sopApprovalAlreadyProcessed: {
    zh: '该审批已被其他人处理',
    en: 'This approval has already been processed by someone else',
  },
  sopApprovalDecisionFailed: { zh: '审批决策失败', en: 'Approval decision failed' },
  sopQuickDecisionApprove: { zh: '同意', en: 'Approve' },
  sopQuickDecisionReject: { zh: '驳回', en: 'Reject' },
  sopQuickDecisionDone: { zh: '审批完成', en: 'Approval Completed' },
  sopQuickDecisionDoneHint: {
    zh: '您已选择「{decision}」，可以关闭此页面。',
    en: 'You have selected "{decision}". You may close this page.',
  },
  sopQuickDecisionConflict: { zh: '已被处理', en: 'Already Processed' },
  sopQuickDecisionConflictHint: {
    zh: '该审批已被其他人处理，无需重复操作',
    en: 'This approval has been processed by someone else. No further action needed',
  },
  sopQuickDecisionInvalidLink: { zh: '无效的审批链接', en: 'Invalid approval link' },
  sopQuickDecisionExpired: {
    zh: '审批链接无效或已过期，请联系发起人重新发送',
    en: 'Approval link is invalid or expired, please contact the initiator to resend',
  },
  sopEdgeLabelApprove: { zh: '通过', en: 'Approve' },
  sopEdgeLabelReject: { zh: '驳回', en: 'Reject' },
  sopEdgeLabelTimeout: { zh: '超时', en: 'Timeout' },

  // ── Conversation engine (extra) ──
  convFileReceived: {
    zh: '已收到您发送的文件 {files}，请问您希望我如何处理？',
    en: 'Received your file(s) {files}. How would you like me to process them?',
  },
  convProcessFailed: { zh: '对话处理失败', en: 'Conversation processing failed' },
  convModelUsage: {
    zh: '调用 {model}，消耗 {tokens} tokens',
    en: 'Called {model}, consumed {tokens} tokens',
  },
  convExecFailed: { zh: '执行失败', en: 'Execution failed' },
  convToolCallFailed: { zh: '工具调用失败', en: 'Tool call failed' },
  convUnknownTool: { zh: '未知工具', en: 'Unknown tool' },
  convError: { zh: '错误', en: 'Error' },
  convNotStreamDirect: { zh: '非 SSE，直接使用', en: 'Not SSE, using directly' },
  convAttachment: { zh: '附件', en: 'Attachment' },
  convIntentNoKnowledge: { zh: '未绑定知识库', en: 'No knowledge base bound' },
  convIntentNoWorkflow: { zh: '未绑定工作流', en: 'No workflow bound' },
  convIntentParseFailed: { zh: '无法解析分类结果', en: 'Unable to parse classification result' },
  convIntentUnknown: { zh: '未知意图', en: 'Unknown intent' },
  convIntentParseError: { zh: '解析失败', en: 'Parse failed' },
  convIntentDegradeTools: {
    zh: '分类降级：默认走工具路径',
    en: 'Classification degraded: defaulting to tool path',
  },
  convIntentDegradeKnowledge: {
    zh: '分类降级：默认查知识库',
    en: 'Classification degraded: defaulting to knowledge query',
  },
  convIntentDegradeNoResource: {
    zh: '分类降级：无资源可用',
    en: 'Classification degraded: no resources available',
  },
  convKnowledgeReference: { zh: '参考', en: 'Reference' },
  convModelNotFound: { zh: '员工 {id} 不存在', en: 'Employee {id} not found' },
  convModelNoAvailable: {
    zh: '未配置可用模型，请在系统设置中配置并激活，或为员工绑定模型',
    en: 'No available model configured, please configure and activate in system settings, or bind a model to the employee',
  },
  convModelNoApiKey: {
    zh: '模型 {model} 未配置 API Key，请在模型配置中设置',
    en: 'Model {model} has no API Key configured, please set it in model configuration',
  },
  convModelUnsupportedProvider: {
    zh: '不支持的 provider: {provider}，请在模型配置中指定 OpenAI 兼容端点',
    en: 'Unsupported provider: {provider}, please specify an OpenAI-compatible endpoint in model configuration',
  },
  convFileOriginalName: { zh: '原始文件名', en: 'Original filename' },
  convFileBytes: { zh: '字节', en: 'bytes' },
  convFileType: { zh: '类型', en: 'Type' },
  convFileHours: { zh: '小时', en: 'hours' },
  convIntentKeepEmpty: { zh: '保留接口，始终为空', en: 'Reserved interface, always empty' },
  convSopToolDesc: {
    zh: '启动标准操作流程「{name}」。当用户提出与此流程相关的任务时，调用此工具执行。',
    en: 'Start standard operating procedure "{name}". Call this tool when the user requests a task related to this procedure.',
  },
  sopNoPermission: {
    zh: '您没有权限执行该任务【{name}】',
    en: 'You do not have permission to run the task "{name}"',
  },
  convSopStatusToolDesc: {
    zh: '查询已启动的 SOP 执行进度和状态。当用户询问之前触发的 SOP 的进度、状态、结果时使用此工具，而不是重新触发 SOP。',
    en: 'Query the execution progress and status of a started SOP. Use this tool when the user asks about the progress, status, or result of a previously triggered SOP, instead of re-triggering it.',
  },
  convSopStatusToolParam: {
    zh: '之前触发 SOP 时返回的执行编号（execution_id），可从对话历史中获取',
    en: 'The execution ID returned when the SOP was previously triggered, can be obtained from conversation history',
  },
  convTaskListToolDesc: {
    zh: '查询当前用户的任务列表。当用户询问"我的任务"、"进行中的任务"、"已完成的任务"、"任务进度"等时使用此工具。',
    en: 'Query current user task list. Use when user asks about "my tasks", "in-progress tasks", "completed tasks", "task progress", etc.',
  },
  convTaskFilterAll: { zh: '全部任务', en: 'All tasks' },
  convTaskFilterActive: {
    zh: '进行中的任务（等待中、执行中、等待人工确认）',
    en: 'Active tasks (pending, running, awaiting confirmation)',
  },
  convTaskFilterDone: {
    zh: '已结束的任务（已完成、失败、超时、出错、已取消）',
    en: 'Finished tasks (completed, failed, timed out, error, cancelled)',
  },
  convTaskLimitDesc: {
    zh: '返回条数，默认 5，最大 20',
    en: 'Number of results, default 5, max 20',
  },
  convTriggerParams: {
    zh: '从用户消息中提取的触发参数（如查询条件、人员、合同名称、金额等）',
    en: 'Trigger parameters extracted from user message (e.g. query conditions, names, contract names, amounts, etc.)',
  },
  convTriggerParamsAll: {
    zh: '从用户消息中提取的触发参数，请务必提取所有字段',
    en: 'Trigger parameters extracted from user message, be sure to extract all fields',
  },
  convExtractedParams: {
    zh: '从用户消息中提取的参数',
    en: 'Parameters extracted from user message',
  },
  convCallTool: { zh: '调用工具：{name}', en: 'Calling tool: {name}' },
  convSopBridge: { zh: '「{name}」；{desc}', en: '"{name}"; {desc}' },
  convSopBridgeNonCritical: { zh: '非关键路径，忽略', en: 'Non-critical path, ignoring' },

  // ── Channel plugins ──
  channelPluginDingtalk: { zh: '钉钉', en: 'DingTalk' },
  channelPluginFeishu: { zh: '飞书', en: 'Feishu' },
  channelPluginWecom: { zh: '企业微信', en: 'WeCom' },
  channelPluginWxoa: { zh: '微信公众号', en: 'WeChat Official Account' },
  channelDingtalkDecryptFailed: { zh: '钉钉事件解密失败', en: 'DingTalk event decryption failed' },
  channelDingtalkEmpty: { zh: '空', en: 'Empty' },
  channelDingtalkFileMsg: { zh: '文件消息', en: 'File message' },
  channelDingtalkMsg: { zh: '消息', en: 'Message' },
  channelWecomSignCompare: { zh: '签名对比', en: 'Signature comparison' },
  channelWecomNone: { zh: '无', en: 'None' },
  channelWecomNoTag: { zh: '无标签', en: 'No tag' },
  channelWecomDecryptResult: { zh: '解密结果', en: 'Decryption result' },
  channelWecomDetail: { zh: '详情', en: 'Detail' },
  channelWxoaUserFollowed: { zh: '用户关注了公众号', en: 'User followed the official account' },
  channelWxoaMenuClick: { zh: '菜单点击', en: 'Menu click' },
  channelDiscordDownloadFailed: { zh: '代理下载失败', en: 'Proxy download failed' },
  channelTelegramApproved: { zh: '已通过', en: 'Approved' },
  channelTelegramRejected: { zh: '已驳回', en: 'Rejected' },

  // ── Channel senders / card builders ──
  channelDingtalkTokenFailed: {
    zh: '获取钉钉 Access Token 失败',
    en: 'Failed to get DingTalk access token',
  },
  channelDingtalkDmFailed: { zh: '钉钉单聊消息发送失败', en: 'DingTalk DM failed to send' },
  channelDingtalkGroupFailed: {
    zh: '钉钉群聊消息发送失败',
    en: 'DingTalk group message failed to send',
  },
  channelDingtalkOtoFailed: {
    zh: '钉钉 OTO 消息发送失败',
    en: 'DingTalk OTO message failed to send',
  },
  channelDingtalkUploadFailed: { zh: '钉钉文件上传失败', en: 'DingTalk file upload failed' },
  channelDingtalkDownloadFailed: { zh: '钉钉文件下载失败', en: 'DingTalk file download failed' },
  channelDingtalkDownloadNoUrl: {
    zh: '钉钉文件下载失败: 未返回 URL',
    en: 'DingTalk file download failed: no URL returned',
  },
  channelDingtalkContentFailed: {
    zh: '钉钉文件内容下载失败',
    en: 'DingTalk file content download failed',
  },
  channelFeishuTokenFailed: {
    zh: '获取飞书 Tenant Token 失败',
    en: 'Failed to get Feishu tenant token',
  },
  channelFeishuSendFailed: { zh: '飞书消息发送失败', en: 'Feishu message send failed' },
  channelFeishuReplyFailed: { zh: '飞书消息回复失败', en: 'Feishu message reply failed' },
  channelFeishuUploadFailed: { zh: '飞书文件上传失败', en: 'Feishu file upload failed' },
  channelFeishuDownloadFailed: { zh: '飞书文件下载失败', en: 'Feishu file download failed' },
  channelWxoaSendFailed: {
    zh: '公众号客服消息发送失败',
    en: 'Official account customer service message failed',
  },
  channelWxoaImageLabel: { zh: '图片', en: 'Image' },
  channelWxoaImageFailed: {
    zh: '公众号图片消息发送失败',
    en: 'Official account image message failed',
  },
  channelWxoaTokenFailed: {
    zh: '微信公众号 Access Token 获取失败',
    en: 'WeChat Official Account access token retrieval failed',
  },
  channelWxoaTokenBadResponse: {
    zh: '微信公众号 Access Token 响应格式异常',
    en: 'WeChat Official Account access token response format error',
  },
  channelWecomFileDownloadFailed: { zh: '企微文件下载失败', en: 'WeCom file download failed' },
  channelFileDownloadFailed: { zh: '文件下载失败', en: 'File download failed' },
  channelFileDownloadBadResponse: { zh: '返回无效', en: 'Invalid response' },
  channelImapNoBody: { zh: '无正文', en: 'No body' },
  channelImapSubjectPrefix: { zh: '【{name}】', en: '[{name}]' },
  channelWecomDecodeError: {
    zh: '解码后应为 {expected} 字节，实际 {actual} 字节',
    en: 'Expected {expected} bytes after decoding, got {actual} bytes',
  },
  channelWecomPaddingError: { zh: '填充长度无效', en: 'Invalid padding length' },
  channelCardColon: { zh: '：', en: ': ' },

  // ── Email sender ──
  emailPendingConfirm: { zh: '待确认', en: 'Pending' },

  // ── Generation pipeline ──
  genSelectingModel: { zh: '正在选择生成模型...', en: 'Selecting generation model...' },
  genBuildingPrompt: { zh: '正在构建生成提示词...', en: 'Building generation prompt...' },
  genCallingLlm: {
    zh: '正在调用 {model} 生成工作流...',
    en: 'Calling {model} to generate workflow...',
  },
  genFormatError: { zh: 'JSON 格式错误，正在重试...', en: 'JSON format error, retrying...' },
  genParseFailed: { zh: '解析失败，已重试 {count} 次', en: 'Parse failed, retried {count} times' },
  genServiceUnavailable: {
    zh: '服务暂时不可用，正在重试...',
    en: 'Service temporarily unavailable, retrying...',
  },
  genNoResult: {
    zh: '生成失败：未获得有效结果',
    en: 'Generation failed: no valid result obtained',
  },
  genAssessingQuality: { zh: '正在评估工作流质量...', en: 'Assessing workflow quality...' },
  genSavingResult: { zh: '正在保存生成结果...', en: 'Saving generation result...' },
  genNoAvailableModel: {
    zh: '无可用生成模型：请在「模型配置」页面配置并启用至少一个',
    en: 'No available generation model: please configure and enable at least one on the Model Configuration page',
  },
  genLlmStreamNotSupported: {
    zh: '生成模式不支持流式响应',
    en: 'Generation mode does not support streaming response',
  },
  genLlmCallFailed: { zh: 'LLM 调用失败', en: 'LLM call failed' },
  genLlmTimeout: { zh: '生成超时', en: 'Generation timed out' },
  genLlmTimeoutSec: { zh: '生成超时（{sec} 秒）', en: 'Generation timed out ({sec}s)' },
  genLlmMissingNodes: { zh: '缺少 nodes 数组', en: 'Missing nodes array' },
  genLlmMissingEdges: { zh: '缺少 edges 数组', en: 'Missing edges array' },
  genLlmInvalidFormat: { zh: '无效的 JSON 格式', en: 'Invalid JSON format' },
  genLlmNodeMissingField: { zh: '节点缺少必要字段', en: 'Node missing required fields' },
  genLlmNodeInvalidPosition: { zh: '节点位置信息无效', en: 'Node position is invalid' },
  genLlmEdgeMissingField: { zh: '边缺少必要字段', en: 'Edge missing required fields' },
  genLlmEdgeBadSource: {
    zh: '边引用了不存在的源节点',
    en: 'Edge references non-existent source node',
  },
  genLlmEdgeBadTarget: {
    zh: '边引用了不存在的目标节点',
    en: 'Edge references non-existent target node',
  },
  genLlmRetryPrompt: {
    zh: '你之前的输出有 JSON 格式错误：{errors}\n请严格按照要求的 JSON 格式重新生成',
    en: 'Your previous output had JSON format errors: {errors}\nPlease regenerate strictly following the required JSON format',
  },
  genLlmRetryApology: {
    zh: '抱歉，我之前的输出格式有误。让我重新生成。',
    en: 'Sorry, my previous output format was incorrect. Let me regenerate.',
  },
  genQualityNoNodes: { zh: '工作流没有节点', en: 'Workflow has no nodes' },
  genQualityInvalidBlocks: {
    zh: '以下节点使用了未注册的算子类型',
    en: 'The following nodes use unregistered block types',
  },
  genQualityAllValid: {
    zh: '全部 {count} 个节点使用有效算子',
    en: 'All {count} nodes use valid blocks',
  },
  genQualityValidCount: {
    zh: '{valid}/{total} 个节点使用有效算子',
    en: '{valid}/{total} nodes use valid blocks',
  },
  genQualityNoKeywords: {
    zh: '无法从需求中提取关键词',
    en: 'Unable to extract keywords from requirements',
  },
  genQualityUncovered: {
    zh: '以下需求关键词未在工作流中体现',
    en: 'The following requirement keywords are not reflected in the workflow',
  },
  genQualityCovered: {
    zh: '{count}/{total} 个需求关键词被覆盖',
    en: '{count}/{total} requirement keywords covered',
  },
  genQualityNoWriteOps: {
    zh: '工作流无写操作节点，无需安全检查',
    en: 'No write operation nodes in workflow, no safety check needed',
  },
  genQualityUnsafeWrite: {
    zh: '以下写操作节点缺少前置验证步骤',
    en: 'The following write operation nodes lack preceding validation steps',
  },
  genQualitySafeWrite: {
    zh: '{count} 个写操作节点有前置验证',
    en: '{count} write operation nodes have preceding validation',
  },

  // ── License ──
  licExpiredCannotCreate: {
    zh: 'License 已过期，无法创建新员工。请联系管理员续期。',
    en: 'License has expired, cannot create new employees. Please contact the administrator to renew.',
  },
  licInvalidCannotCreate: {
    zh: 'License 无效，无法创建新员工。请联系管理员检查 License 文件。',
    en: 'License is invalid, cannot create new employees. Please contact the administrator to check the license file.',
  },
  licQuotaReached: {
    zh: '员工配额已达上限（{current}/{max}），请联系管理员升级 License。',
    en: 'Employee quota reached ({current}/{max}), please contact the administrator to upgrade the license.',
  },
  licValid: {
    zh: 'License 验证通过 — 客户：{customer}，员工配额：{quota}，到期：{expiry}',
    en: 'License valid — Customer: {customer}, Quota: {quota}, Expires: {expiry}',
  },
  licExpired: { zh: 'License 已过期', en: 'License has expired' },
  licInvalidFormat: { zh: 'License 文件格式无效', en: 'License file format is invalid' },
  licSignatureFailed: { zh: '签名验证失败', en: 'Signature verification failed' },
  licSignatureError: { zh: '签名验证过程出错', en: 'Signature verification process error' },
  licReadFailed: { zh: 'License 文件读取失败', en: 'License file read failed' },

  // ── Model test ──
  modelTestHello: {
    zh: '你好，请用一句话简单介绍自己。',
    en: 'Hello, please introduce yourself in one sentence.',
  },
  modelTestNotRegistered: {
    zh: '{provider} 不在注册表中',
    en: '{provider} is not in the registry',
  },
  modelTestTimeout: { zh: '模型测试超时', en: 'Model test timed out' },
  modelTestStreamSuccess: {
    zh: '模型连接测试成功（流式响应）',
    en: 'Model connection test succeeded (streaming response)',
  },
  modelTestSuccess: { zh: '模型连接测试成功', en: 'Model connection test succeeded' },
  modelTestFailed: { zh: '模型测试失败：{error}', en: 'Model test failed: {error}' },
  modelTestNoModelName: {
    zh: '未配置模型名称，请先在模型配置中填写模型名称',
    en: 'Model name not configured, please set it in model configuration first',
  },

  // ── Ragflow / Knowledge base ──
  ragflowNotConfigured: { zh: '知识库连接未配置', en: 'Knowledge base connection not configured' },
  ragflowDecryptFailed: {
    zh: '知识库连接配置解密失败',
    en: 'Knowledge base connection config decryption failed',
  },
  ragflowMissingConfig: {
    zh: '知识库 endpoint 或 apiKey 缺失',
    en: 'Knowledge base endpoint or apiKey missing',
  },
  ragflowInvalidResponse: { zh: '无效 HTTP 响应', en: 'Invalid HTTP response' },
  ragflowApiError: { zh: '知识库 API 错误', en: 'Knowledge base API error' },
  ragflowTimeout: { zh: '知识库请求超时', en: 'Knowledge base request timed out' },
  ragflowNetworkError: { zh: '知识库网络错误', en: 'Knowledge base network error' },
  ragflowConnRefused: {
    zh: '（连接被拒绝，请检查知识库服务是否启动及端口是否正确）',
    en: '(Connection refused, please check if the knowledge base service is running and port is correct)',
  },
  ragflowDnsError: {
    zh: '（域名解析失败，请检查 endpoint 地址是否正确）',
    en: '(DNS resolution failed, please check if the endpoint address is correct)',
  },
  ragflowConnReset: {
    zh: '（连接被重置，请检查网络或防火墙设置）',
    en: '(Connection reset, please check network or firewall settings)',
  },
  ragflowTlsError: {
    zh: '（网络不通或 TLS 握手失败，请检查地址和网络）',
    en: '(Network unreachable or TLS handshake failed, please check address and network)',
  },
  ragflowDatasetNotFound: { zh: '知识库不存在', en: 'Knowledge base not found' },
  ragflowDocNotFound: { zh: '文档不存在', en: 'Document not found' },
  ragflowHealthOk: { zh: '知识库连接正常', en: 'Knowledge base connection is healthy' },
  ragflowAuthFailed: { zh: '知识库认证失败', en: 'Knowledge base authentication failed' },
  ragflowResourceNotFound: { zh: '知识库资源未找到', en: 'Knowledge base resource not found' },
  ragflowServerError: { zh: '知识库服务端错误', en: 'Knowledge base server error' },
  ragflowRequestFailed: { zh: '知识库请求失败', en: 'Knowledge base request failed' },
  ragflowResliceStarted: { zh: '重新切片处理已启动', en: 'Re-chunking process has been started' },

  // ── Sandbox ──
  sandboxWorkflowNotFound: {
    zh: '工作流不存在或未分配工作区',
    en: 'Workflow does not exist or is not assigned to a workspace',
  },
  sandboxWorkflowNoState: { zh: '工作流状态未保存', en: 'Workflow state not saved' },
  sandboxNodeNotFound: { zh: '节点 {id} 不存在', en: 'Node {id} does not exist' },
  sandboxSopNotFound: { zh: 'SOP 定义不存在', en: 'SOP definition does not exist' },
  sandboxSopDisabled: { zh: 'SOP 未启用', en: 'SOP is not enabled' },
  sandboxSopStartFailed: {
    zh: '启动 SOP 执行失败: {error}',
    en: 'Failed to start SOP execution: {error}',
  },
  sandboxStateSyncTimeout: { zh: '沙盒状态同步超时', en: 'Sandbox state sync timed out' },
  sandboxWorkflowNotFound2: { zh: '工作流不存在', en: 'Workflow does not exist' },
  sandboxTimeout: {
    zh: '沙盒试跑超时（{min} 分钟）',
    en: 'Sandbox test run timed out ({min} minutes)',
  },

  // ── Dify ──
  difyInvalidToken: { zh: 'API Key 无效或已过期', en: 'API Key is invalid or expired' },
  difyBadRequest: { zh: '请求参数错误', en: 'Bad request parameters' },
  difyNotFound: { zh: 'App 不存在或 URL 路径错误', en: 'App does not exist or URL path error' },
  difyHttpError: { zh: 'Dify 返回 HTTP {status}', en: 'Dify returned HTTP {status}' },
  difyTimeout: { zh: '请求超时（{sec}s）', en: 'Request timed out ({sec}s)' },
  difyUnknownError: { zh: '未知错误', en: 'Unknown error' },
  difyConnFailed: { zh: '连接失败', en: 'Connection failed' },
  difySendChat: { zh: '发送 Dify 对话（新对话）', en: 'Sending Dify chat (new conversation)' },
  difyHumanInterrupt: {
    zh: '工作流触发了 human_interaction 节点，请前往 Dify 操作',
    en: 'Workflow triggered human_interaction node, please go to Dify to operate',
  },
  difyReplyLength: { zh: '对话回复（{len} 字）', en: 'Chat reply ({len} chars)' },

  // ── OpenClaw ──
  openclawInvalidToken: { zh: 'API Key 无效或已过期', en: 'API Key is invalid or expired' },
  openclawHttpError: { zh: 'OpenClaw 返回 HTTP {status}', en: 'OpenClaw returned HTTP {status}' },
  openclawTimeout: { zh: '请求超时（{sec}s）', en: 'Request timed out ({sec}s)' },
  openclawUnknownError: { zh: '未知错误', en: 'Unknown error' },
  openclawConnFailed: { zh: '连接失败', en: 'Connection failed' },
  openclawToolSuccess: { zh: '工具 {name} 执行成功', en: 'Tool {name} executed successfully' },
  openclawCallTool: { zh: '调用 OpenClaw 工具: {name}', en: 'Calling OpenClaw tool: {name}' },
  openclawToolFailed: { zh: '工具 {name} 执行失败', en: 'Tool {name} execution failed' },
  openclawWorkflowExecFailed: {
    zh: '工作流执行失败: {error}',
    en: 'Workflow execution failed: {error}',
  },
  openclawWorkflowNeedsApproval: { zh: '工作流需要审批', en: 'Workflow requires approval' },
  openclawWorkflowSuccess: {
    zh: '工作流 {name} 执行成功',
    en: 'Workflow {name} executed successfully',
  },
  openclawWorkflowCompleted: {
    zh: '工作流 {name} 执行完成',
    en: 'Workflow {name} execution completed',
  },
  openclawTaskNotFound: { zh: '任务不存在', en: 'Task does not exist' },
  openclawTaskNotPending: {
    zh: '任务不在等待审批状态',
    en: 'Task is not in pending approval status',
  },
  openclawMissingSnapshot: {
    zh: '缺少 stateSnapshot，无法恢复工作流',
    en: 'Missing stateSnapshot, cannot resume workflow',
  },
  openclawResumeFailed: { zh: '恢复失败', en: 'Resume failed' },
  openclawApproveResume: {
    zh: '审批通过，OpenClaw 工作流继续执行',
    en: 'Approved, OpenClaw workflow resuming',
  },
  openclawRejectCancel: {
    zh: '审批拒绝，OpenClaw 工作流已取消',
    en: 'Rejected, OpenClaw workflow cancelled',
  },

  // ── K8s / Skill deployment ──
  k8sLoadAsModule: {
    zh: '加载 {file} 为模块（支持 npm 第三方库）',
    en: 'Loading {file} as module (supports npm packages)',
  },
  k8sSubprocess: {
    zh: '用子进程执行 Python 完全独立的 Python 环境，可自由 import',
    en: 'Using subprocess to execute Python in isolated environment',
  },
  k8sParseOutput: {
    zh: '解析输出（最后一行应该是 JSON）',
    en: 'Parsing output (last line should be JSON)',
  },
  k8sRuntimeInstalled: {
    zh: '运行时是否已安装（按需安装，安装后缓存）',
    en: 'Whether runtime is installed (install on demand, cached)',
  },
  k8sInstalling: { zh: '正在安装中（防重入）', en: 'Installing (re-entrance guard)' },
  k8sIgnore: { zh: '忽略', en: 'Ignore' },
  k8sParamsInjected: { zh: '参数在执行时注入', en: 'Parameters injected at execution time' },

  // ── System health ──
  healthCheckFailed: { zh: '检查失败', en: 'Check failed' },
  healthNotConfigured: { zh: '未配置', en: 'Not configured' },
  healthModelsAvailable: { zh: '{count} 个模型可用', en: '{count} models available' },
  healthOllamaNotDetected: {
    zh: '未检测到运行中的 Ollama 实例，请确认 Ollama 已启动',
    en: 'No running Ollama instance detected, please confirm Ollama is started',
  },

  // ── Stats ──
  statsAggFailed: { zh: '聚合失败', en: 'Aggregation failed' },

  // ── Formatting (relative time) ──
  timeJustNow: { zh: '刚刚', en: 'just now' },
  timeMinutesAgo: { zh: '{n} 分钟前', en: '{n}m ago' },
  timeHoursAgo: { zh: '{n} 小时前', en: '{n}h ago' },
  timeDaysAgo: { zh: '{n} 天前', en: '{n}d ago' },

  // ── Block categories (server side) ──
  blockCatTrigger: { zh: '触发器', en: 'Triggers' },
  blockCatProcess: { zh: '处理', en: 'Processing' },
  blockCatDataSource: { zh: '数据源', en: 'Data Sources' },
  blockCatNotification: { zh: '推送通知', en: 'Notifications' },
  blockCatScraping: { zh: '数据抓取', en: 'Web Scraping' },
  blockCatProjectMgmt: { zh: '项目管理', en: 'Project Management' },
  blockCatFileStorage: { zh: '文件存储', en: 'File Storage' },
  blockCatFlowControl: { zh: '流程控制', en: 'Flow Control' },
  blockCatOther: { zh: '其他', en: 'Other' },
  blockCatAgent: { zh: '智能体', en: 'Agent' },
  blockCatDatabase: { zh: '数据库', en: 'Database' },
  blockCatEmail: { zh: '邮件', en: 'Email' },
  blockCatNotify: { zh: '通知', en: 'Notification' },

  // ── Task query ──
  taskFilterRunning: { zh: '进行中的', en: 'in-progress ' },
  taskFilterCompleted: { zh: '已完成的', en: 'completed ' },
  taskFilterAll: { zh: '所有', en: 'all' },
  taskNoTasks: { zh: '当前没有{filter}任务。', en: 'No {filter}tasks at the moment.' },
  taskListHeader: {
    zh: '以下是你的{filter}任务（共 {count} 条）：\n',
    en: 'Here are your {filter}tasks ({count} total):\n',
  },
  taskUnknownProcess: { zh: '未知流程', en: 'Unknown process' },
  taskLineItem: {
    zh: '{index}. 【{status}】{name}（编号：{id}）— {time}',
    en: '{index}. [{status}] {name} (ID: {id}) — {time}',
  },
  taskErrorPrefix: { zh: '   错误：{error}', en: '   Error: {error}' },

  // ── Workflow bridge ──
  wfNotFound: { zh: '工作流 {id} 不存在', en: 'Workflow {id} does not exist' },
  wfConversationTrigger: { zh: '对话触发：{args}', en: 'Conversation trigger: {args}' },
  wfConversationTriggerSuccess: {
    zh: '对话触发工作流执行成功',
    en: 'Conversation-triggered workflow execution succeeded',
  },
  wfExecutionFailed: { zh: '执行失败', en: 'Execution failed' },
  wfUnknownError: { zh: '未知错误', en: 'Unknown error' },
  wfNoOutput: { zh: '无输出', en: 'No output' },

  // ── Load generated DAG ──
  dagNoValidBlocks: { zh: '无有效的算子类型', en: 'No valid block types' },
  dagLoadFailed: { zh: '加载失败', en: 'Load failed' },

  // ── LLM switch gateway evaluation ──
  llmInsufficientWords: {
    zh: '未提供|缺失|没有提供|无法判断',
    en: 'not provided|missing|unavailable|cannot determine',
  },
  llmDataWords: { zh: '信息|数据', en: 'information|data' },
  llmBranchSelectWords: { zh: '选择|分支|编号', en: '' },
  llmFullwidthColon: { zh: '：', en: '' },
  llmFullwidthPeriod: { zh: '。', en: '' },
  cjkSentenceBreaks: { zh: '。|！|？', en: '' },
} as const

type MessageKey = keyof typeof messages

/**
 * Get localized string
 * @param key message key
 * @param lang language code: 'zh' for Chinese, anything else for English
 * @param params optional template parameters: {name}, {id}, {status}
 */
export function t(key: MessageKey, lang = 'zh', params?: Record<string, string>): string {
  const entry = messages[key]
  let text: string = lang === 'zh' ? entry.zh : entry.en
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v)
    }
  }
  return text
}
