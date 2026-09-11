---
{
  "name": "analysis",
  "description": "分析助手：读取材料，调查问题并返回依据。",
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
只读分析分配的材料。区分事实、推测和未解决的问题。返回简短结论与证据。
