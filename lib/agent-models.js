/**
 * dsh-plugin-code-studio / agent-models —— 「按角色指定子 Agent 模型」的 Host 设置条目
 *
 * 独立 profile 条目（cordis.patch.yml 的 `code-studio-agent-models`），
 * 只提供一个可被设置页读写的服务 `codeStudioAgentModels`。字段必须 `.volatile()`，
 * 否则设置页读不到、写回报 `Config field "..." is not volatile`。
 *
 * 导出形状照抄官方先例：具名导出 + default 导出同一个 Service 类 + 显式 name。
 * 本文件自身就是插件，default 是安全的；只有 lib/index.js 那种命名空间承载
 * inject/name/apply 的文件绝不能加 default。
 */

import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

/** 与 lib/index.js 的 ROLE_IDS 保持一致。 */
export const ROLE_IDS = [
  'tech-lead', 'planner', 'implementer', 'reviewer', 'security', 'test', 'maintenance',
];

const AssignmentSchema = z.object({
  role: z.string().required(),
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
});

export class CodeStudioAgentModelsConfig extends Service {
  static Config = z.object({
    enabled: z.boolean().default(false).volatile(),
    assignments: z.array(AssignmentSchema).default([]).volatile(),
  });

  constructor(ctx, config) {
    super(ctx, 'codeStudioAgentModels');
    this.config = config;
  }

  /**
   * 读一个 volatile 字段。标了 `.volatile()` 的字段在 cordis 里是带 `.get()` 的
   * 访问器对象，不是裸值；当裸值迭代会抛 `object is not iterable`。
   */
  readField(name, fallback) {
    const field = this.config?.[name];
    if (field === undefined || field === null) return fallback;
    if (typeof field.get === 'function') {
      const value = field.get();
      return value === undefined ? fallback : value;
    }
    return field;
  }

  /** 规范化后的指派表：过滤残缺项、去重、只保留已知角色。 */
  current() {
    const assignments = [];
    const seen = new Set();
    const rawList = this.readField('assignments', []);
    for (const raw of Array.isArray(rawList) ? rawList : []) {
      const role = String(raw?.role ?? '').trim();
      const provider = String(raw?.provider ?? '').trim();
      const model = String(raw?.model ?? '').trim();
      if (!role || !provider || !model) continue;
      if (!ROLE_IDS.includes(role)) continue;
      if (seen.has(role)) continue;
      seen.add(role);
      const effort = String(raw?.reasoningEffort ?? '').trim();
      assignments.push({ role, provider, model, ...(effort ? { reasoningEffort: effort } : {}) });
    }
    return { enabled: this.readField('enabled', false) === true, assignments };
  }

  /** 某个角色被指定的模型；未开启或未指派时返回 undefined（继承父 Agent）。 */
  routeFor(role) {
    if (this.readField('enabled', false) !== true) return undefined;
    return this.current().assignments.find((item) => item.role === role);
  }
}

const name = 'code-studio-agent-models';

export { CodeStudioAgentModelsConfig as default, name };
