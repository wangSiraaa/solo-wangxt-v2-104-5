<script lang="ts">
  import type { AppState } from '../db/state.svelte';
  let { app }: { app: AppState } = $props();
  const s = app.state;
  let name = $state('');
  let handoffInput = $state<HTMLInputElement | null>(null);
</script>

<div class="panel stack">
  <h2>本机工程（IndexedDB）</h2>
  <div class="row">
    <input type="text" placeholder="工程名称（可选）" bind:value={name} />
    <button onclick={() => app.saveProject(name)} disabled={!s.image || !s.sourceProfile}>保存工程</button>
  </div>
  {#if s.projects.length === 0}
    <div class="small muted">尚无保存的工程。图片与配置不会上传，全部保存在此浏览器内。</div>
  {:else}
    <div class="projlist scroll">
      {#each s.projects as p (p.id)}
        <div class="row spread pl">
          <button class="ghost left" onclick={() => app.loadProject(p.id)} title="载入工程">
            <span>{p.name}</span>
            <span class="small muted">{new Date(p.updatedAt).toLocaleString()}</span>
          </button>
          <button class="ghost small" title="把该工程导出为交接包" onclick={() => app.exportHandoffProject(p.id)}>包</button>
          <button class="ghost small danger" onclick={() => app.deleteProject(p.id)}>删</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<div class="panel stack">
  <h2>工程交接包（跨浏览器离线传递）</h2>
  <div class="small muted">
    交接包（.spkg）携带原图、源配置证据（嵌入 ICC 或人工假设）、所需 ICC 二进制与
    SHA-256 指纹、目标条件与格式版本。导入方先完整校验清单与内容关联，全部合法才一次性写入
    IndexedDB；同指纹配置安全复用，同名不同字节隔离保留。
  </div>
  <div class="row">
    <button
      class="primary"
      onclick={() => app.exportHandoff(name)}
      disabled={!s.image || !s.sourceProfile || !s.targetProfile || s.busyHandoff}
    >
      导出当前工程为交接包
    </button>
    <button onclick={() => handoffInput?.click()} disabled={s.busyHandoff}>
      {s.busyHandoff ? '处理中…' : '导入交接包…'}
    </button>
    <input
      type="file"
      accept=".spkg"
      style="display:none"
      bind:this={handoffInput}
      onchange={(e) => {
        const f = (e.currentTarget as HTMLInputElement).files?.[0];
        if (f) app.importHandoff(f);
        (e.currentTarget as HTMLInputElement).value = '';
      }}
    />
  </div>

  {#if s.handoffReport}
    {@const r = s.handoffReport}
    <div class="report" class:bad={!r.ok}>
      <div class="row spread">
        <strong class={r.ok ? 'ok' : 'danger'}>
          {r.ok ? `✓ 交接包导入完成：${r.projectName ?? r.fileName}` : `✗ 交接包被拒绝：${r.fileName}`}
        </strong>
        <button class="ghost small" onclick={() => app.dismissHandoffReport()}>关闭</button>
      </div>
      {#if !r.ok}
        <div class="small danger">未写入任何内容：工程库与配置库均无变化。</div>
        <ul class="small">
          {#each r.errors as e}<li>{e}</li>{/each}
        </ul>
      {:else}
        {#if r.branchNote}<div class="small">{r.branchNote}</div>{/if}
        {#if r.reused.length}<div class="small ok">复用本机同指纹配置（未复制）：{r.reused.join('、')}</div>{/if}
        {#if r.added.length}<div class="small">新增配置：{r.added.join('、')}</div>{/if}
        {#each r.conflicts as c}<div class="small warn">冲突：{c}</div>{/each}
        {#each r.migrations as m}<div class="small muted">迁移：{m}</div>{/each}
        {#if r.provenanceWarning}<div class="small warn">{r.provenanceWarning}</div>{/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .projlist {
    max-height: 160px;
  }
  .pl {
    border-bottom: 1px solid #ffffff08;
    gap: 6px;
  }
  .left {
    text-align: left;
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  .report {
    border: 1px solid #2f6b4c;
    background: #1f3a2b33;
    border-radius: 8px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .report.bad {
    border-color: #6b2f2f;
    background: #3a1f1f33;
  }
  .report ul {
    margin: 0;
    padding-left: 18px;
  }
</style>
