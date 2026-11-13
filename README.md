# dsh-plugin-code-studio 路 浠ｇ爜鎬荤紪宸ヤ綔瀹?
鍙傝€?`dsh-plugin-novel`锛堝皬璇存€荤紪宸ヤ綔瀹わ級涓?SuperAgent 缂栨帓鎻掍欢鍋氱殑**浠ｇ爜鐢熶骇**鐗堟湰銆?鎶€鏈€荤洃涓嶅啓浠ｇ爜锛屽彧杈撳嚭宸ヤ綔娴?+ 娲惧崟缁?13 涓鑹插瓙 Agent锛涙瘡寮犲崟杩?`code_task` 璐︺€?鏈?`write_scope` 鏂囦欢纭竟鐣屻€佽繃銆屾満鍣ㄩ棬 `code_check` + 鐙珛瀹℃牎銆嶄袱閬撻棬銆?
## 瑁?
鏈彃浠舵槸 profile 鍐呯殑 bundle 灞傦紝闈?`cordis.patch.yml` 鎻掑叆锛堜笌 novel 鍚屾瀯锛夛細

```yaml
- insert:
    - id: code-studio
      name: 'dsh-plugin-code-studio'
    - id: code-studio-agent-models
      name: 'dsh-plugin-code-studio/agent-models'
```

瑙掕壊 鈫?妯″瀷鎸囨淳鍦ㄨ缃〉鐨?`code-studio-agent-models` 鏉＄洰閲岄厤锛坄enabled` + `assignments[{role,provider,model,reasoningEffort}]`锛夈€?鏈寚娲剧殑瑙掕壊缁ф壙鎶€鏈€荤洃鐨勬ā鍨嬨€?
## 宸ュ叿

| 宸ュ叿 | 鐢ㄩ€?|
|---|---|
| `code_roles` | 鍙栨煇瑙掕壊鍗″叏鏂囷紙娲惧崟鍓嶅繀璇伙紝闅忔彁绀鸿瘝涓€璧风粰瀛?Agent锛?|
| `code_brief` | 缁勮瀹炵幇浠诲姟涓婁笅鏂囧寘锛堢洰鏍?+ 鐩稿叧鏂囦欢鎽樺綍 + 濂戠害 + 绾︽潫 + 楠屾敹锛?|
| `code_check` | 鑷姩鏈哄櫒闂細鎸夌粰瀹氬懡浠ら€愭潯璺戯紝鍏ㄨ繃鎵?PASS锛堟妧鏈€荤洃鍞竴璺戝懡浠ょ殑绐勯€氶亾锛?|
| `code_state` | 璐︽湰瑙嗗浘锛氫换鍔℃寜鐘舵€佸垎缁勶紝鐪嬩笅涓€姝ヨ娲捐皝 |
| `code_task` | 浠诲姟璐︼細open/claim/renew/settle/release/cancel/pick/get/list/reclaim/events |
| `code_dispatch` | 鎸夎鑹叉淳鍗曪紙鑷姩濂楃敤璁剧疆鐨勬ā鍨嬶級锛岀珛鍗宠繑鍥炲瓙浼氳瘽 id锛屼笉绛夛紱鏀寔 variants 骞宠鐗堟湰 |
| `code_eval` | 娲惧崟鍓嶈瘎浼伴棬锛堝榻?SuperAgent Eval锛夛細鎸変换鍔″崟瀹屾暣搴﹁鍐?proceed/clarify/reject |
| `code_review` | 闈欐€佸鏍℃壂鎻忥細寰呭姙鏍囪 / console.log / debugger / any / 绌?catch / 瓒呴暱鍑芥暟 / 纭紪鐮佸瘑閽?|
| `code_map` | 渚濊禆鍥撅細鎵悇鍖呮竻鍗曞缓鍐呴儴渚濊禆鏈夊悜鍥俱€佸垪澶栭儴渚濊禆銆佹壘寰幆渚濊禆 |
| `code_kb` | 浠ｇ爜鑼冧緥搴擄細鎸夎涔夛紙bge-m3 鍚戦噺锛岄€€璇嶆硶锛夋矇娣€/妫€绱€屽啓瀵逛簡鐨勪唬鐮併€嶈寖渚?|
| `code_studio` | 宸ヤ綔鍖哄伐浣滃鍙拌处锛歩ssue 褰掑睘 region銆佹淳缁欐寔涔呭瓙浼氳瘽銆佸紑鍏崇洃鍚敹浠剁洰褰曘€佸缓 PR锛坄assign`/`issues`/`regions`/`set`/`dispatch`/`watch`/`pr`锛?|

## 宸ヤ綔瀹わ細鐩戝惉 鈫?娲惧崟 鈫?鎶ュ憡锛堝浠撳簱锛?
鎸夊伐浣滃尯锛堜細璇濈粦鐨勯偅涓枃浠跺す锛夌嫭绔嬬洃鍚紝閰嶇疆钀藉湪 `<repo>/.codewrite/watch.json`锛屼笉鐢ㄥ～璺緞锛?
1. 浼氳瘽缁戝埌鏌愪釜浠撳簱鏂囦欢澶瑰悗锛宍code_studio`锛堟垨 `/code-studio-watch on`锛夊紑鍚洃鍚€?2. 寰€ `<repo>/.codewrite/inbox/` 涓竴涓?`*.json`锛歚{ "id"?: "12", "title": "淇櫥褰?, "body": "鍘熸枃", "folders": ["src/auth"] }`
   鈥斺€?杞鍣ㄤ笅涓€杞紙榛樿 60s锛夋妸瀹冨彉鎴?issue 骞舵淳鍗曘€?3. **鎸佷箙瀛愪細璇濇寜 region 澶嶇敤**锛氬悓涓€鐗囨枃浠跺す鐨勫悗缁?issue 杩藉洖鍚屼竴涓瓙浼氳瘽涓茶杩藉姞锛屾崲鐗囨墠鏂板缓锛?   鍦ㄩ鐨?region 鍒嗙粍 鈮?2锛屽瓙浼氳瘽涓嶅緱鍐嶆淳 `tech-lead`銆?4. 瀛愪細璇濈粨绠楁椂锛屾姤鍛婂洖鍐?`issues.json`锛?*鍙充晶鏍忋€屽伐浣滃銆嶉〉**鍚屽睆鍛堢幇 issue 鍒楄〃 / 宸ヤ綔鐘舵€佸浘 / 鎶ュ憡锛屽乏渚х収甯告槸浼氳瘽鍖恒€?
**鎵撳紑鏂瑰紡**锛氱偣浼氳瘽鍙充晶鏍忓簳閮ㄧ殑 `</>` 鍚姩鍣紝鎵撳紑銆屽伐浣滃銆嶅彸渚ф爮椤碉紙`sidebar.footer.action` 鈫?`sidebarRight.openTab('code-studio')`锛夈€?涓棿閭ｅ潡鏄?*宸ヤ綔鐘舵€佸浘锛堣妭鐐硅繛绾垮浘锛?*锛歚宸ヤ綔鍖?鈫?region 鈫?issue` 涓夊眰鑺傜偣鐢ㄨ繛绾胯繛璧锋潵锛岀洿鎺ョ湅鍝釜 region / 瀛?Agent 鍦ㄨ窇锛圧UNNING 鐨?region 鍜?issue 浼氶粍鑹查珮浜?鑴夊啿锛夛紝鐐?issue 鑺傜偣鍒囨崲鍙充晶鎶ュ憡銆傜偣銆屽缓 PR銆嶅 `DONE` 鐨?issue 璧?gh 寤?PR锛堣涓嬶級銆?
### 宸ヤ綔鍖虹淮鎶ょ粍锛堣嚜鍔ㄥ垏鍒板伐浣滃妯″紡锛?
姣忎釜宸ヤ綔鍖猴紙= 浼氳瘽缁戠殑閭ｄ釜鏂囦欢澶癸級鏈変竴涓?*缁存姢缁?*锛氬彧瑕佹弧瓒充换涓€鏉′欢锛屽氨鎶?*鍓嶅彴浼氳瘽鐨?Agent 棰勮鑷姩鍒囨垚 `code-editor`锛堜唬鐮佹€荤紪/鎶€鏈€荤洃妯″紡锛?*鈥斺€?
1. 瀵硅瘽涓€寮€濮嬪氨鐢ㄣ€屼唬鐮佹€荤紪宸ヤ綔瀹ゃ€嶉璁惧彂璧凤紙`code-editor`锛夛紱
2. 鎵嬪姩鎵撳紑宸ヤ綔瀹ゅ彸渚ф爮椤碉紙姝ゆ椂鑻ュ綋鍓嶄細璇濊繕鏄┖浼氳瘽銆佹病寮€濮嬪璇濓紝浼氳嚜鍔ㄥ垏锛夈€?
瑙勫垯锛?- 鍙**绌轰細璇?*锛堣繕娌″彂杩囨秷鎭級鑷姩鍒囷紝涓嶆墦鏂繘琛屼腑鐨勬櫘閫氬璇濓紱
- 姣忎釜浼氳瘽姣忛〉闈㈢敓鍛藉懆鏈熷彧灏濊瘯涓€娆★紝涓嶅弽澶嶆姠锛?- 闈㈡澘椤堕儴鏈?*妯″紡 chip**锛氭樉绀恒€屼唬鐮佹€荤紪宸ヤ綔瀹?/ 鏅€氥€嶏紱闈炲伐浣滃妯″紡鏃跺彸渚у嚭鐜般€屽垏鎹㈠埌宸ヤ綔瀹ゆā寮忋€嶆寜閽紝闅忔椂涓€閿垏銆?
搴曞眰璧?`remote.agentPresets.select(sessionId, 'code-editor')`锛屾病鏈夊叏灞€鍓綔鐢紝鍙綔鐢ㄤ簬褰撳墠浼氳瘽銆?

鐩戝惉閰嶇疆锛歚/code-studio-watch on|off|scan|interval <ms>`锛屾垨 `code_studio` 鐨?`watch` action銆?浠撳簱鏍瑰嚭鐜?`.codewrite/`锛歚issues.json`銆乣regions.json`銆乣watch.json`銆乣inbox/`銆乣editor/`锛堝伐浣滃尯璁板繂锛?鈥斺€?鍧囦负杩愯浜х墿锛屽缓璁繘 `.gitignore`銆?
### 寤?PR锛堣蛋鏈満 gh CLI锛屾彃浠朵笉鐣?key锛?
瀵规煇涓?`DONE` 鐨?issue锛宍/code-studio-watch pr <issueId>`锛堟垨 `code_studio` 鐨?`pr` action / 宸ヤ綔瀹ら〉銆屽缓 PR銆嶆寜閽級浼氾細

1. 鏍￠獙鐩爣鐩綍鏄?git 浠撳簱锛?2. `gh auth status` 鏍￠獙宸茬櫥褰曪紙鏈櫥褰曚細鎻愮ず `gh auth login`锛夛紱
3. 鍒囧埌 `issue/<id>` 鍒嗘敮 鈫?鏈夋敼鍔ㄥ垯 `add + commit` 鈫?`git push -u origin issue/<id>`锛?4. `gh pr create --base main --head issue/<id> --title 鈥?--body 鈥锛岃繑鍥?PR 閾炬帴銆?
**鍓嶆彁**锛氳 `gh`锛坄winget install --id GitHub.cli -e`锛夊苟 `gh auth login -h github.com` 涓€娆°€?鍑嵁瀛樺湪 gh 鑷繁鐨?`hosts.yml`锛屾彃浠?*涓嶄繚瀛樹换浣?GitHub 鍑嵁**銆傚彧寤?PR銆?*涓嶈嚜鍔ㄥ悎骞躲€佷笉鑷姩鎺?main**锛涘啿绐佺暀缁欎汉澶勭悊銆?
### GitHub 婧愶紙浠?GitHub Issues 鎷夊崟锛?
闄や簡鏈湴鏀朵欢鐩綍锛屼篃鑳界洿鎺ョ粦涓€涓?GitHub 浠撳簱锛屾妸瀹冪殑 open issues 褰撴潵婧愶紱閰嶇疆钀?`<repo>/.codewrite/github.json`锛?
- 浼氳瘽閲?`/code-studio-watch github owner/repo`锛堜篃鎺ュ彈瀹屾暣 GitHub URL锛夆啋 寮€锛沗github off` 鈫?鍏炽€?- 绉佹湁浠撳簱鎴栨兂鎻愰搴︼細**鎵嬪姩瀛?PAT**銆備細璇濋噷 `/code-studio-watch token <pat>`锛屾垨鍦ㄣ€屽伐浣滃銆峊ab 椤堕儴鐨?**PAT** 涓€鏍忕矘璐达紙password 杈撳叆妗嗭級鐐逛繚瀛橈紱`/code-studio-watch token off`锛堟垨 Tab 閲岀偣娓呴櫎锛夊垹鎺夈€?- PAT 鍗曠嫭瀛?`<repo>/.codewrite/github-token`锛堢函鏂囨湰锛屼粎鏈満锛夛紝**涓嶈繘 `github.json`銆佷笉杩涚増鏈簱**锛沗github.json` 閲屽彧璁?`enabled/repo/labels/assignee/intervalMs`锛孴ab 鍙樉绀恒€屽凡瀛?鏈瓨銆嶏紝姘歌繙璇讳笉鍒版槑鏂囥€?- 涔熷彲鍦ㄣ€屽伐浣滃銆峊ab 椤堕儴鐨?**GitHub 婧?* 涓€鏍忓～ `owner/repo` 鐐圭粦瀹氥€?- 鎷夊彇瑙勫垯锛氬彧瑕?`state=open`銆佹帓闄?PR锛沬ssue 姝ｆ枃閲屽啓 `folders: src/a, src/b` 鎴栧嚭鐜板儚璺緞鐨?token锛屼細鑷姩鎶芥垚 region 鐨勬枃浠跺す銆?- 杞甯?ETag锛?04 涓嶉噸鎷夛級锛岄粯璁?120s锛沗/code-studio-watch scan` 绔嬪嵆鎷変竴娆°€?- 宸叉淳杩囩殑 issue 缂栧彿璁板湪 `issues.json`锛岄噸澶嶆媺鍙栦笉浼氶噸娲俱€?
## 纭檺鍒讹紙code-guard锛?
鎸傚湪 `presets/code-editor/agent.cordis.yml` 鐨勯璁惧瓙鎻掍欢锛屽彧瀵逛娇鐢ㄦ湰棰勮鐨勬€荤洃浼氳瘽鐢熸晥锛?- 灏侊細`write` / `edit` / `pwsh` / `bash` / `subagent` / `subagent_fork`銆?- 鏀捐鍙锛歚read` / `glob` / `grep` / `code_brief` / `code_state` / `code_check`銆?- 鍐欑櫧鍚嶅崟锛歚.codewrite/editor/*.md`锛堟€荤洃鐨勮蹇嗘枃浠讹級銆?- 瀛?Agent 涓嶅彈闄愬埗锛坓uard 鎸?`origin:'subagent'` / `delegationDepth` 鏀捐锛夛紝浣嗗厛鏍￠獙 `write_scope`銆?
## 鐩綍

```
lib/          index.js(娉ㄥ唽) code-guard.js dispatch.js orchestrator.js task-registry.js
              session-roles.js packet.js runner.js agent-models.js
              studio-store.js studio-memory.js studio-dispatch.js studio-watch.js studio-github.js studio-pr.js
presets/code-editor/
              preset.yml agent.cordis.yml orchestration.md roles/*.md(13)
```

姣忎釜 `studio-*.js` 閮芥槸鍙嫭绔嬭嚜娴嬬殑绾€昏緫妯″潡锛坄node lib/studio-store.js` 绛夎嚜甯?demo锛夈€?
## 澶嶇敤璇存槑锛坧onytail锛?
`task-registry.js` / `orchestrator.js` / `dispatch.js` / `session-roles.js` 鍥涗唤鐢?novel 鎻掍欢閫愬瓧鎼潵锛?鍙敼浜嗙姸鎬佺洰褰曞墠缂€锛坄.codewrite/`锛変笌宸ュ叿鍚嶏紙`code_dispatch`锛夈€備笉涓轰竴涓父閲忓鍒舵暣浠芥ā鍧楋紝涔熶笉閲嶉€犲凡鏈夌殑缂栨帓閫昏緫銆?
## 浠撳簱渚х姸鎬?
璺戣捣鏉ュ悗浠撳簱鏍逛細鍑虹幇 `.codewrite/`锛歚agents/`锛堜换鍔¤处 registry.json + 浜嬩欢 .jsonl + orphaned/锛夈€?`editor/`锛堟€荤洃璁板繂锛夈€乣ledger/`锛堟。妗堜氦鎺ワ級銆乣issues.json`/`regions.json`/`watch.json`/`github.json`/`inbox/`锛堝伐浣滃鍙拌处涓庣洃鍚潵婧愶級銆?杩欐槸杩愯浜х墿锛屽缓璁繘 `.gitignore`锛堟湰浠撳簱宸查粯璁ゅ拷鐣ワ級銆?
## 璁稿彲

MIT銆傝 [LICENSE](./LICENSE)銆?