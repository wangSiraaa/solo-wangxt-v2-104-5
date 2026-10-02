<script lang="ts">
  import type { AppState } from '../db/state.svelte';
  let { app }: { app: AppState } = $props();
  const s = app.state;
  let name = $state('');
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
            <span class="projname">
              {p.name}
              {#if p.handover}<span class="tag hv">交接包</span>{/if}
              {#if p.legacy}<span class="tag legacy" title="旧格式工程：无指纹，按原记录载入，与新交接包共存">旧格式</span>{/if}
            </span>
            <span class="small muted">{new Date(p.updatedAt).toLocaleString()}</span>
          </button>
          <button class="ghost small danger" onclick={() => app.deleteProject(p.id)}>删</button>
        </div>
      {/each}
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
  .projname {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tag {
    font-size: 10px;
    padding: 0 5px;
    border-radius: 4px;
    border: 1px solid #ffffff33;
    white-space: nowrap;
  }
  .tag.hv {
    background: #23445a;
    border-color: #4a8ab066;
  }
  .tag.legacy {
    background: #4a3f23;
    border-color: #b0934a44;
  }
</style>
