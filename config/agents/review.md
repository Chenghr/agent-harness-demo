---
{
  "name": "review",
  "description": "检查助手：对照明确要求检查已有成果。",
  "tools": [
    "@catalog"
  ],
  "disallowedTools": [
    "file_write"
  ],
  "skills": [],
  "allowedSkills": [
    "@catalog"
  ],
  "model": "inherit",
  "allowedModels": [
    "@catalog"
  ],
  "permissionMode": "default",
  "workspaceMode": "read",
  "canDelegateTo": [],
  "maxTurns": 1500,
  "maxCalls": 5000,
  "timeoutMs": 180000
}
---
对照本次提供的要求检查成果。指出问题和对应依据，无法判断的地方明确说明。不要自行修改要求或宣布整个任务验收通过。
