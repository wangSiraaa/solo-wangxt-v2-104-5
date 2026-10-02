<script lang="ts">
  import type { AppState } from '../db/state.svelte';
  import { HANDOVER_EXTENSION } from '../version';

  let { app }: { app: AppState } = $props();
  const s = app.state;
  let name = $state('');
  let exporting = $state(false);
  let exportErr = $state('');
  let importInput = $state<HTMLInputElement | null>(null);

  const outcomeLabel: Record<string, string> = {
    imported: '新工程已导入',
    'idempotent-skip': '重复导入：内容相同，已幂等跳过',
    'reference-repaired': '重复导入：工程已存在，已补齐缺失的配置引用',
    'name-conflict-renamed': '同名不同内容：已隔离并改名',
  };

  async function doExport() {
    exporting = true;
    exportErr = '';
    try {
      const r = await app.exportHandover(name);
      if (!r.ok) exportErr = r.error ?? '导出失败';
    } finally {
      exporting = false;
    }
  }

  async function onPickFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    if (f) await app.importHandover(f);
    input.value = '';
  }
</script>

<div class="panel stack handover">
  <h2>工程交接包（离线浏览器可复现）</h2>
  <div class="small muted">
    打包 <strong>原始图片 + 源依据（嵌入或人工假设 ICC）+ 目标 ICC + 指纹 + 目标条件</strong>
    为单个 {HANDOVER_EXTENSION} 文件。导入前完整校验清单与内容关联，全部合法才一次性落库；篡改/截断一律拒绝。
  </div>
  <div class="row">
    <input type="text" placeholder="工程名称（可选）" bind:value={name} />
    <button onclick={doExport} disabled={!s.image || !s.sourceProfile || !s.targetProfile || exporting || s.busyHandover}>
      {exporting || s.busyHandover ? '处理中…' : '导出交接包'}
    </button>
  </div>
  {#if exportErr}<div class="small danger">✗ {exportErr}</div>{/if}
  <div class="row">
    <input
      type="file"
      accept={HANDOVER_EXTENSION}
      bind:this={importInput}
      onchange={onPickFile}
    />
  </div>

  {#if s.handoverReport}
    {@const r = s.handoverReport}
    <div class="report {r.ok ? 'okbox' : 'badbox'}">
      <div class="rep-head">
        {#if r.ok}
          <span class="badge ok">✓ 导入成功</span>
        {:else}
          <span class="badge bad">✗ 已拒绝（{r.rejectedStage}）</span>
        {/if}
        <button class="ghost small" onclick={() => app.dismissHandoverReport()}>关闭</button>
      </div>
      <div class="small mono muted">{r.packageName} · 格式 v{r.formatVersion ?? '?'}{#if r.exportedAt} · 导出于 {new Date(r.exportedAt).toLocaleString()}{/if}</div>

      {#if !r.ok}
        <div class="small danger">{r.error}</div>
        <div class="small muted">项目库与配置库均无任何写入或残留。</div>
      {:else}
        <div class="small">
          <strong>工程：</strong>{outcomeLabel[r.project.outcome] ?? r.project.outcome}
          「{r.project.name}」
        </div>
        {#if r.project.outcome === 'name-conflict-renamed'}
          <div class="small warn">本机已有同名工程但内容不同，已保留双方并将导入项改名为「{r.project.name}」。</div>
        {/if}
        {#if r.project.outcome === 'idempotent-skip'}
          <div class="small muted">检测到内容键完全相同的工程，未重复写入。</div>
        {/if}
        <div class="proflines">
          {#each r.profiles as p}
            <div class="small rowline">
              {#if p.action === 'reused'}
                <span class="badge reuse">复用</span>
              {:else}
                <span class="badge add">新增</span>
              {/if}
              <span class="badge cs">{p.key === 'target' ? '目标' : '假设源'}</span>
              <span title={p.fingerprint}>{p.description}</span>
            </div>
            {#if p.reusedFromBuiltin}
              <div class="small muted indent">命中本机内置开放配置（同指纹引用，不复制）。</div>
            {/if}
            {#each p.nameCollision as c}
              <div class="small danger indent">
                ⚠ 同名不同字节：本机「{c.description}」指纹 {c.fingerprint?.slice(0, 12) ?? '?'}…
                与包内不同；已按指纹隔离存储，未合并。
              </div>
            {/each}
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .handover {
    border-color: #4a6a8a55;
  }
  .report {
    border-radius: 8px;
    padding: 8px 10px;
    border: 1px solid;
  }
  .okbox {
    background: #1f3a2530;
    border-color: #3f7a4f66;
  }
  .badbox {
    background: #3a202040;
    border-color: #7a303066;
  }
  .rep-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }
  .badge.ok {
    background: #2e6b3e;
  }
  .badge.bad {
    background: #8a3030;
  }
  .badge.reuse {
    background: #4a5a7a;
  }
  .badge.add {
    background: #2e6b5e;
  }
  .badge.cs {
    background: #3a3a4a;
  }
  .rowline {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 3px;
  }
  .indent {
    margin-left: 46px;
  }
  .proflines {
    margin-top: 4px;
  }
</style>
