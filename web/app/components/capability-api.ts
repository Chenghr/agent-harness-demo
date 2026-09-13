import type {
  Capability,
  Directory,
  Report,
} from '../../../server/runtime/capabilities/types';
export type Entry = {
  id: string;
  name: string;
  title: string;
  kind: string;
  description: string;
  enabled?: boolean;
  simulated?: boolean;
  path?: { id: string; name: string }[];
  count?: number;
};
export type View = Directory & {
  items: Entry[];
  total: number;
  nextOffset: number | null;
  path: { id: string; name: string }[];
};
export type Detail = Capability & {
  files: Record<string, string>;
  history: Report[];
  versions: { version: string }[];
};
export type Job = {
  id: string;
  kind: string;
  status: string;
  total: number;
  completed: number;
  errors: string[];
  model: string | null;
};
export type Model = {
  id: string;
  label: string;
  configured?: boolean;
  simulated?: boolean;
  available?: boolean;
};
export async function request<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok)
    throw new Error(data.error?.message ?? `请求失败 ${response.status}`);
  return data as T;
}
export const statusText: Record<string, string> = {
  queued: '等待评估',
  running: '评估中',
  completed: '已完成',
  cancelled: '已取消',
  failed: '未完整完成',
};
export const conflictText: Record<string, string> = {
  duplicate: '内容重复',
  name: '名称重复',
  update: '发现新版本',
  similar: '功能相近',
  contradiction: '疑似矛盾',
};
export const riskText: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  insufficient: '无法充分判断',
};
