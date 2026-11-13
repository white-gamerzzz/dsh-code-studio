/**
 * dsh-plugin-code-studio / pozhang-settings —— 「破障」设置页的 Host 侧条目
 *
 * 只在设置页里暴露三个字段：中继开关、端口、上游地址。
 * 进程的启停不在这里做——lib/index.js 的 20s 巡检读这几个字段做收敛，
 * 这样设置页只负责"写配置"，生命周期仍只有一处来源。
 *
 * 字段必须 .volatile()，否则设置页写回报 `Config field "..." is not volatile`。
 * 导出形状照抄 ./agent-models（具名 + default + name）。
 */

import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export class PozhangSettings extends Service {
  static Config = z.object({
    interceptEnabled: z.boolean().default(true).volatile(),
    relayEnabled: z.boolean().default(false).volatile(),
    relayPort: z.number().default(8788).volatile(),
  });

  constructor(ctx, config) {
    super(ctx, 'pozhangSettings');
    this.config = config;
  }

  /** 读一个 volatile 字段：带 .get() 的访问器，不是裸值。 */
  readField(name, fallback) {
    const field = this.config?.[name];
    if (field === undefined || field === null) return fallback;
    if (typeof field.get === 'function') {
      const value = field.get();
      return value === undefined ? fallback : value;
    }
    return field;
  }
}

export const name = 'pozhang-settings';
export default PozhangSettings;
