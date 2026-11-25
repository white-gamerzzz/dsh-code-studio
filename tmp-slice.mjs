// 一次性切片脚本：删 code_task/code_dispatch/code_eval 三段 + 注册数组收敛。用完即删。
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'lib/tools.js';
const lines = readFileSync(file, 'utf8').split('\n');
const idxOf = (needle) => lines.findIndex((l) => l.includes(needle));

// 1) 删 code_task + code_dispatch 两个整段（含各自的 --- 头），保留 code_brief 头。
const iTask = idxOf('// code_task');
const iBrief = idxOf('// code_brief');
if (iTask < 0 || iBrief < 0 || iBrief < iTask) throw new Error(`markers: task=${iTask} brief=${iBrief}`);
lines.splice(iTask - 1, iBrief - iTask);

// 2) 删 code_eval 整段（重找，下标已变）。
const iEval = idxOf('// code_eval');
const iStudio = idxOf('// code_studio');
if (iEval < 0 || iStudio < 0 || iStudio < iEval) throw new Error(`markers: eval=${iEval} studio=${iStudio}`);
lines.splice(iEval - 1, iStudio - iEval);

let src = lines.join('\n');

// 3) imports 收敛。
src = src.replace("import { SETTLE_STATUSES, workspaceMatches } from './task-registry.js';\n", '');
src = src.replace("import { ROLE_IDS, buildRolesTool } from './roles.js';\n", '');
src = src.replace("import { assessDispatch, renderEval } from './eval.js';\n", '');
src = src.replace(/^import \{ DISPATCH_TOOL.*from '\.\/dispatch\.js';\n/m, '');
src = src.replace(
  "import { dispatchIssue, settleIssue, cleanupWorkspace, mergeWorkspace, regionSettled, pendingMerges } from './studio-dispatch.js';",
  "import { dispatchIssue, prepareIssue, settleIssue, cleanupWorkspace, mergeWorkspace, regionSettled, pendingMerges } from './studio-dispatch.js';",
);

// 4) env 注入收敛。
src = src.replace('    routeForRole,\n', '');
src = src.replace('    spawnMerger,\n', '');
src = src.replace('    orchestratorFor,\n', '');
src = src.replace('    registryFor,\n', '');

// 5) 注册数组与 return 收敛。
src = src.replace(
  '  const tools = [\n    buildRolesTool(), buildBriefTool(), buildCheckTool(), buildStateTool(), buildTaskTool(), buildDispatchTool(),\n    buildKbTool(), buildMapTool(), buildReviewTool(), buildEvalTool(), studioTool, mergeTool,\n    buildMemoryTool(), buildOpTool(),\n  ];',
  '  const tools = [\n    buildBriefTool(), buildCheckTool(), buildStateTool(),\n    buildKbTool(), buildMapTool(), buildReviewTool(), studioTool, mergeTool,\n    buildMemoryTool(), buildOpTool(),\n  ];',
);
src = src.replace('    buildTaskTool,\n    buildDispatchTool,\n', '');
src = src.replace('    buildEvalTool,\n', '');

// 6) opRegistry 去掉重复的 merge 注册。
src = src.replace("    .register('mergeStatus', viaTool(mergeTool, 'status'))\n    .register('merge', viaTool(mergeTool, 'merge'))\n", "    .register('mergeStatus', viaTool(mergeTool, 'status'))\n");

writeFileSync(file, src, 'utf8');
console.log('sliced ok, lines now', src.split('\n').length);
