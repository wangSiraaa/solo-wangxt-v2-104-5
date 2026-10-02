# 软打样台 · Soft-Proof Bench

一个**纯浏览器** ICC 软打样工作台。先让印前人员明确图片来自哪个色彩空间，再查看转换到印厂配置后的颜色变化。所有像素处理与 ICC 转换都在本机用 WebAssembly 完成，**图片与配置不上传任何服务器**。

- **色彩引擎**：[LittleCMS 2](https://github.com/mm2/Little-CMS) 的 WebAssembly 构建 [`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm)
- **界面**：Svelte 5 + TypeScript + Vite
- **预览**：双 Canvas 并排（原图 / 软打样模拟），点击/悬停取样
- **解码**：`@jsquash` WASM 解码 PNG(8/16-bit)/JPEG/WebP，取原始像素，不经过浏览器色彩管理
- **导出**：自写 PNG（RGB/Gray，8/16-bit，嵌入 iCCP）与 CMYK TIFF 编码器
- **工程交接包**：可验证的单文件 `.spbpkg`（原图、嵌入/人工假设源依据 ICC、目标 ICC、SHA-256 指纹、目标条件、元数据与格式版本）；导入先完整校验再以一次原子事务落库
- **存储**：IndexedDB 保存工程与 ICC 配置库

## 工作流程（与印前纪律对应）

1. **导入图片**（PNG/JPEG/WebP）。读取嵌入 ICC：
   - 有嵌入配置 → 显示其描述、版本、色彩空间（如 `RGB v2.2`），转换以它为准；
   - **缺少配置 → 必须手工选择一个源配置**，选择会作为“假设（assumption）”写入设置记录，不做任何静默猜测。
2. **选择目标印厂配置、渲染意图（4 种）、黑点补偿**，以及软打样模拟意图。
3. **并排预览**：左侧为原始像素；右侧为 `源配置 →（目标设备 proofing）→ sRGB 显示` 的软打样结果。
4. **取样**：在任一画布悬停或单击钉选，查看源/目标设备值（RGB %、CMYK 0–100、灰阶）、两边的 CIE Lab（LittleCMS double 精度）与 ΔE2000、Alpha。
5. **导出**：
   - 转换图像：目标为 RGB/Gray → 嵌入目标 ICC 的 PNG；目标为 CMYK → 嵌入目标 ICC 的 8-bit CMYK TIFF；
   - 设置记录：单独的 JSON，标明源/目标配置、源假设、意图码、BPC、像素哈希与免责声明；
   - 图像文件都带 `softproof-bench-conversion` 标记（PNG tEXt / TIFF ImageDescription）。
6. **防止二次转换**：再次导入带标记的“已转换”文件会被识别并拦截，不能把转换结果当原图再转一次。
7. **交接给另一台离线浏览器**：导出单个 `.spbpkg` 工程交接包（见下节）。

> ⚠️ 未经校准/特征化的显示器上，软打样**不承诺**等同实物打样或印刷成品颜色；本工具用于流程核对、配置确认与数值预览。

## 可验证的工程交接包（.spbpkg）

单独“保存工程”留在本机 IndexedDB、导出图片又只是转换结果，都无法把**准确原图、源依据与目标条件**交给另一台离线浏览器。交接包把它们打进一个容器：

- **原始图片**（PNG/JPEG/WebP，逐字节）；
- **源配置证据**：图片嵌入 ICC（并重新从图片提取比对），或人工假设的说明 + 假设所用 ICC 二进制；
- **所需 ICC**：假设源（如有）与目标印厂配置，各自带 **SHA-256 指纹**；
- **目标条件**：目标配置、渲染意图、黑点补偿、软打样意图；
- **工程元数据与显式格式版本**（`softproof-bench-handover` v1）。

容器布局：`SPBPKG01` 魔数 + 清单 JSON（条目指纹表）+ 内容寻址二进制 + `SPBEND01` 尾部整体 SHA-256。

**导入保证**

1. 先校验尾哈希（任何篡改/截断/追加都失败），再逐条目复核指纹、核对清单条目表；
2. 语义校验：容器与位深、ICC 合法性、嵌入证据必须与图片**实际**嵌入字节一致、人工假设必须带说明且图片确无嵌入、目标意图合法；
3. 带转换标记的图片一律拒绝——交接路径不能绕过现有“二次转换”保护；
4. 全部合法后，配置与工程在**一次跨 store 的 IndexedDB 事务**里落库；任何一步失败，项目库与配置库都无半个工程或孤儿配置残留。

**复用与隔离**

- 配置按 SHA-256 指纹匹配：本机已有相同字节（含内置开放配置）时**引用复用、不复制**；
- 同名不同字节**绝不合并**：导入项以 `sha256:<指纹>` 确定性 ID 独立存储，并保留包内来源（来自哪个工程、角色、导出时间），界面显式标出冲突；
- 工程身份是内容键：同一包重复导入稳定**幂等跳过**；同名不同内容则改名并存（明确分支，不静默覆盖）。

**共存与迁移**

- IndexedDB schema 版本不变；旧格式（无指纹）工程仍可载入，列表标“旧格式”，载入时提示按原记录读取；新交接包工程带“交接包”标记，二者共存。
- 旧配置行在启动时于单事务内惰性补算指纹，界面给出迁移提示。
- 载入任何工程都会复核原图/配置指纹与引用完整性，缺配置或指纹不符时可见告警（恢复结果）。

## 目录

```
src/lib/
  icc/      ICC 头/标签解析、JPEG APP2 / PNG iCCP / WebP ICCP 提取、出处标记检测
  color/    LittleCMS WASM 封装、转换引擎、CIEDE2000、设置记录
  codec/    WASM 解码，PNG / CMYK-TIFF 编码（可嵌 ICC）
  handover/ 交接包容器、清单校验、指纹复用/隔离规划、原子导入
  db/       IndexedDB、内置开放配置、应用状态（runes）
  workers/  后台转换线程与主线程 client
  components/  Svelte UI
scripts/      Node 单测、夹具生成、Playwright E2E
public/profiles/  内置开放 ICC（Elle Stone，公有领域/CC0）
test-assets/       色块图、透明边缘图、开放 CMYK 配置（CC0）
```

### 两条转换链不混用

- **转换链** `源 → 目标配置设备编码`：这是导出数据，嵌入目标 ICC。
- **软打样链** `源 → sRGB 显示（cmsCreateProofingTransform，目标为 proof 设备）`：只用于屏幕预览，**绝不**回灌为转换输入。

### 关键实现注记

- `lcms-wasm` 的 JS 封装对 `TYPE_*_DBL` 浮点格式有 bug（按 Float32 暂存而 LittleCMS 需要 Float64）。8/16-bit 路径正常；采样所需的 Lab/XYZ/单像素 double 转换直接操作 Emscripten 堆内存（`_malloc` + `Float64Array` + `_cmsDoTransform`）绕过该问题。
- 像素全程保持打包的“颜色通道 + alpha”（RGBA/CMYKA/GRAYA），用 `cmsFLAGS_COPY_ALPHA` 透传 alpha；导出 CMYK（无 alpha 通道的 TIFF）时对完全透明像素清零油墨。

## 使用

```bash
npm install
npm run dev          # 打开本地页面
```

印厂配置（FOGRA/ISOcoated、GRACoL、Japan Color 等）通过界面的“ICC 配置库”导入 `.icc/.icm`，存于本机 IndexedDB，不随网络下载。内置仅含两个开放的 Elle Stone RGB 配置。

## 测试

```bash
npm run check        # svelte-check + tsc
npm run test:node    # ICC 解析/提取、PNG/TIFF 编码、出处标记、ΔE2000
npm run test:handover # 交接包：打包/校验/篡改截断/真实 IndexedDB 原子导入
npm run build        # 生产构建

# E2E（先启动 dev，再用 Playwright 安装好的 Chromium）
npm run dev -- --port 5199 --strictPort
E2E_URL=http://localhost:5199 npm run test:e2e
```

E2E 覆盖：嵌入/缺失配置（强制假设）、CIE RGB 与 CMYK 目标、JPEG(APP2)、16-bit PNG、透明边缘、取样、PNG/TIFF 导出、带标记文件再导入拦截；交接包在全新浏览器上下文（模拟另一台离线浏览器）中复现来源与目标条件、同指纹复用不复制、重复导入幂等、篡改/截断拒绝且两库无残留、旧格式工程与新交接包共存载入。

`test:handover` 用 fake-indexeddb 跑真实 IndexedDB 事务，覆盖：嵌入/假设两种源依据、外层与逐条指纹、篡改/截断/追加、嵌入证据掉包、配置指纹复用（含内置）、同名不同字节隔离、幂等与同名改名分支、拒绝零残留、旧 v0 工程共存。

### 用独立色彩工具验证导出文件

导出文件已用带 lcms 委托的 **ImageMagick 6** 独立验证可被读取：

```bash
identify -verbose export.png | grep -i icc:description     # 目标配置名
identify -verbose export.tif | grep -iE 'Colorspace|icc'   # CMYK + 嵌入 ICC
convert export.tif -colorspace sRGB render.png             # 用嵌入 ICC 独立再渲染
```

数值上，浏览器内 WASM 与 ImageMagick 独立 LCMS 对同一色块（sRGB 纯红 → ISO Coated v2，相对色度+BPC）给出一致的 CMYK `(0,244,254,0)`。

## 开放配置来源

- Elle Stone `elles_icc_profiles`（sRGB、CIE RGB；公有领域/CC0 贡献），随应用内置。
- ISO Coated v2 300%（Amethyst，pmjdebruijn/amethyst-cmyk-icc-profiles，CC0）仅随测试夹具提供，不在应用内分发；正式生产请向印厂索取配置。

## 许可

应用代码 MIT。LittleCMS MIT。解码 WASM（Squoosh 系）Apache-2.0。
