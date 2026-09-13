---
name: delivery-qa-reviewer
description: 独立验收多人祝福网站的成员、文案、图片与音视频版本、主题、可访问性和发布状态；适用于预览后的通过、局部返工或待用户确认判断。
---

# 数字展馆独立验收

检查助手只检查，不修改成果。

1. 调用 `greeting_review` 读取固定预览的确定性检查结果。
2. 若分配了 `members.json`，逐项比较未指定成员的文案原文。
3. 核对成员唯一、图片一一对应、背景音乐与感谢短片均为 ready 本地版本、指定字数、页面标题、主题、替代文本和发布状态。
4. 视觉风格属于人工判断：可根据实际预览指出待确认项，不能只凭提示词宣布一致。
5. 输出 `pass`、`needs_revision` 或 `needs_user_review`，列出证据与最小返工范围。
6. 不生成图片、不修改文件、不申请或批准发布。

详细判定标准见 [references/checklist.md](references/checklist.md)。
