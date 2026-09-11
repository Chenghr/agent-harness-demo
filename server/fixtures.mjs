import { PRIVACY_SOURCE, PRIVACY_RULES } from "./privacy-demo.mjs";
import fs from "node:fs";
import path from "node:path";

export const BROKEN_CART = `export function total(items, discount = 0) {\n  const subtotal = items.reduce((sum, item) => sum + item.price, 0);\n  return Math.round(subtotal * (1 - discount) * 100) / 100;\n}\n`;
export const FIXED_CART = `export function total(items, discount = 0) {\n  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n  return Math.round(subtotal * (1 - discount) * 100) / 100;\n}\n`;
export const CART_TEST = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from './cart.mjs';\ntest('数量参与金额计算', () => assert.equal(total([{price: 12.5, quantity: 3}]), 37.5));\ntest('折扣应用到总金额', () => assert.equal(total([{price: 20, quantity: 2}], 0.1), 36));\ntest('空购物车返回零', () => assert.equal(total([]), 0));\ntest('金额保留两位小数', () => assert.equal(total([{price: 0.1, quantity: 3}]), 0.3));\n`;
export function createWorkspace(root, sessionId, scenario = "full") {
  const dir = path.join(root, "workspaces", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  if (scenario === "privacy") {
    fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify(PRIVACY_SOURCE, null, 2));
    fs.writeFileSync(path.join(dir, "rules.md"), PRIVACY_RULES);
    return dir;
  }
  fs.writeFileSync(path.join(dir, "cart.mjs"), BROKEN_CART);
  fs.writeFileSync(path.join(dir, "cart.test.mjs"), CART_TEST);
  fs.writeFileSync(
    path.join(dir, "README.md"),
    "# 教学示例：购物车金额计算\n\n存在一个数量计算错误。读取代码、运行测试、定位原因。修复实现，不修改测试。\n",
  );
  return dir;
}

export const SCENARIOS = [
  {
    id: "privacy",
    name: "隐私实体数据集",
    subtitle: "读取规则 → 标注合成文本 → 核对边界",
    prompt:
      "按照 rules.md 的本次示例规则，将 source.json 中的合成文本标注为 dataset.json。保留原文，先说明实体边界约定，写入前请我确认，最后检查实体范围、标签和样本完整性。",
    icon: "dataset",
  },
  {
    id: "full",
    name: "完整任务链",
    subtitle: "发现能力 → 后台诊断 → 授权修复",
    prompt:
      "请分析并修复购物车金额计算问题。先运行测试，后台分析边界条件，修改前让我确认。不要修改测试文件。",
    icon: "workflow",
  },
  {
    id: "interrupt",
    name: "打断与资源回收",
    subtitle: "启动长诊断，随时停止或改方向",
    prompt: "启动后台长时间诊断，同时分析购物车问题。我要观察打断和进程回收。先不要修改文件。",
    icon: "pause",
  },
  {
    id: "context",
    name: "上下文与模型交接",
    subtitle: "生成长日志，压缩后继续工作",
    prompt: "分析购物车失败原因，生成详细日志并压缩上下文。不要修改测试文件，也先不要修改实现。",
    icon: "layers",
  },
  {
    id: "security",
    name: "授权边界",
    subtitle: "加载不可信 Skill，观察越界拒绝",
    prompt: "运行安全反例演示：加载不可信 Skill，验证越界读取和修改测试文件会被拒绝。",
    icon: "shield",
  },
  {
    id: "scale",
    name: "千次工具调用",
    subtitle: "真实调度 1005 次模拟数据计算",
    prompt: "执行 1005 次工具调用压力演示，使用模拟数据并记录调用、压缩和资源状态。",
    icon: "activity",
  },
];
