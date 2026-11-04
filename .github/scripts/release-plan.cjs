#!/usr/bin/env node
// 发布决策的纯函数 + 自检。
//
// 为什么要单独拆出来：这些规则全都「不报错但结果不对」，靠人工读 YAML 看不出来。
// 例：草稿已存在时只改说明就退出，看起来成功，实际永远没公开。
// 现在把判定与动作序列抽成纯函数，CI 用 --selftest 跑一遍断言。
//
// 用法：
//   node .github/scripts/release-plan.cjs --selftest
//   node .github/scripts/release-plan.cjs --mode publish --draft true --exists false
'use strict';

// mode: 'dry-run' | 'draft' | 'publish'
// existing: { isDraft: true } | undefined
// draftInput: inputs.draft 的布尔值
function planRelease({ mode, draftInput, existingIsDraft }) {
  if (mode === 'dry-run') return { action: 'none', reason: '演练模式：不创建、不修改任何 Release' };

  // 已公开的版本一律不动：不覆盖说明、不替换资产。
  if (existingIsDraft === false) {
    return { action: 'keep-public', reason: '已存在且已公开，保持原样（不覆盖已发布版本）' };
  }

  const wantDraft = mode === 'draft' || draftInput === true;

  // 已存在草稿：更新说明；若本次要求公开，必须同时取消草稿状态。
  if (existingIsDraft === true) {
    if (wantDraft) return { action: 'edit-draft', reason: '已存在草稿且本次仍要草稿：只更新说明' };
    return { action: 'edit-and-publish', reason: '已存在草稿且本次要求公开：更新说明并取消草稿' };
  }

  if (wantDraft) {
    return { action: 'create-draft', reason: mode === 'draft' ? 'tag 推送只建草稿' : 'confirm=PUBLISH 但 draft=true，仍然只建草稿' };
  }
  return { action: 'create-public', reason: '创建并公开 Release' };
}

function selftest() {
  const cases = [
    { name: '演练不动 Release', input: { mode: 'dry-run', draftInput: false, existingIsDraft: undefined }, want: 'none' },
    { name: '已公开不覆盖', input: { mode: 'publish', draftInput: false, existingIsDraft: false }, want: 'keep-public' },
    { name: 'tag 推送只建草稿', input: { mode: 'draft', draftInput: false, existingIsDraft: undefined }, want: 'create-draft' },
    { name: 'PUBLISH 且 draft=true 仍是草稿', input: { mode: 'publish', draftInput: true, existingIsDraft: undefined }, want: 'create-draft' },
    { name: 'PUBLISH 且无草稿则公开', input: { mode: 'publish', draftInput: false, existingIsDraft: undefined }, want: 'create-public' },
    { name: '草稿+仍要草稿 只改说明', input: { mode: 'publish', draftInput: true, existingIsDraft: true }, want: 'edit-draft' },
    { name: '草稿+要求公开 必须真正发布', input: { mode: 'publish', draftInput: false, existingIsDraft: true }, want: 'edit-and-publish' },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = planRelease(c.input).action;
    const ok = got === c.want;
    if (!ok) failed++;
    console.log((ok ? '  ok   ' : '  FAIL ') + c.name + (ok ? '' : '  期望 ' + c.want + '，实际 ' + got));
  }
  console.log('\n' + (cases.length - failed) + '/' + cases.length + ' 通过');
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const exists = arg('--exists');
  const result = planRelease({
    mode: arg('--mode') || 'dry-run',
    draftInput: arg('--draft') === 'true',
    existingIsDraft: exists === 'true' ? true : exists === 'false' ? false : undefined,
  });
  console.log(JSON.stringify(result));
}
