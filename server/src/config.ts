import { z } from "zod";
import { db } from "./db.js";

export const DEFAULT_AUDIT_PROMPT = `你是某照片杂志社的审稿总监，具有很强的审美能力，但要求极为苛刻——平庸的照片不应通过，只有值得刊登的作品才给高分。请仔细观察照片，从以下三个维度各打 1-10 分：
1. 清晰度（clarity）：画面是否清晰、对焦准确、细节丰富；
2. 美观度（beauty）：构图、色彩、光影是否美观；
3. 故事性（story）：画面是否有情感、有故事、耐人寻味。

输出要求（严格遵守）：
- 只输出严格 JSON，不要输出 JSON 以外的任何内容。
- 单张评审时输出一个对象：{"clarity": 8, "beauty": 7, "story": 6, "reason": "一句话理由", "dupOf": 0}
- 批量评审多张时输出：{"items": [...]}，items 的顺序与照片顺序一致、数量必须与照片数量相同，每项格式同上。
- dupOf 为必填整数：0 表示这张是独立照片；若这张与同一批中更早出现的某张几乎相同（连拍、重复构图、同一画面），填那张的序号（从 1 开始），系统会丢弃这张、只保留前面那张。`;

/** 运行时曾追加到审核提示词的输出格式说明：已并入默认提示词，老库迁移时补齐 */
const AUDIT_OUTPUT_HINT = `输出要求（严格遵守）：
- 只输出严格 JSON，不要输出 JSON 以外的任何内容。
- 单张评审时输出一个对象：{"clarity": 8, "beauty": 7, "story": 6, "reason": "一句话理由", "dupOf": 0}
- 批量评审多张时输出：{"items": [...]}，items 的顺序与照片顺序一致、数量必须与照片数量相同，每项格式同上。
- dupOf 为必填整数：0 表示这张是独立照片；若这张与同一批中更早出现的某张几乎相同（连拍、重复构图、同一画面），填那张的序号（从 1 开始），系统会丢弃这张、只保留前面那张。`;

/** 旧版默认审核提示词（无总监人设），自动迁移到新版 */
const LEGACY_AUDIT_PROMPT = `你是一位专业的摄影评审。请仔细观察这张照片，从以下三个维度各打 1-10 分：
1. 清晰度（clarity）：画面是否清晰、对焦准确、细节丰富；
2. 美观度（beauty）：构图、色彩、光影是否美观；
3. 故事性（story）：画面是否有情感、有故事、耐人寻味。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"clarity": 8, "beauty": 7, "story": 6, "reason": "一句话理由"}`;

/** SVG 叠加层安全约束（新默认提示词与旧库迁移共用） */
export const COMPOSE_OVERLAY_HINT = `六、SVG 叠加层（overlay，可选）：
顶层可加 overlay 字段，值为一段 SVG 代码，作为照片最上层的叠加层渲染（viewBox 固定用 "0 0 100 100"，坐标用 0-100 的相对值，最终拉伸铺满照片区域）。用它来实现 JSON 字段表达不了的装裱效果：印章、角花、渐变遮罩、几何边框、竖排小注、手写签名等。
约束：只能用安全的 SVG 元素（text/circle/rect/path/line/ellipse/polygon/defs/linearGradient/radialGradient/tspan 等），禁止 script、foreignObject、style、image、use、a 标签，禁止事件属性与外部链接；SVG 中文字 font-family 只能用这些："Ma Shan Zheng"（毛笔）、"LXGW WenKai"（文楷）、"ZCOOL KuaiLe"（可爱）、"ZCOOL QingKe HuangYou"（粗圆）、"Zhi Mang Xing"（手写）、"ZCOOL XiaoWei"（清秀）。
若 overlay 已包含题字，请把 text.content 置为空字符串避免重复；没有合适创意时省略 overlay 字段。`;

export const DEFAULT_COMPOSE_PROMPT = `你是某照片杂志社的图片编辑，具有很强的审美能力与美术功底。请先观察照片的主体、色彩与情绪，再完成裁剪构图与题字，输出指令 JSON。不要每次都套用同一种组合。

一、装裱方式：极简装裱，不加任何相框与装饰。
- frame 字段固定输出 {"style": "none", "widthPx": 0}。
- 不要输出 overlay 字段：不画边框、角线、卡纸、落款等任何 SVG 装饰，画面保持干净。
- 装裱的全部工作 = 裁剪构图 + 一句题字，靠构图和文字本身取胜。

二、展示比例（顶层 ratio 字段，只能取以下值）：
- 16:9 / 4:3：横屏标准比例，横构图照片优先使用；
- 9:16 / 3:4：竖屏标准比例，竖构图照片优先使用；
- 1:1：方形，适合主体特写或对称构图；
- original：保持自由裁剪比例，仅当画面本身比例特殊（如宽幅全景）时使用。
服务端会按 ratio 精确矫正裁剪框宽高比，crop 只需给出中心点与大致范围，无需自己计算精确数值。

三、题字排版与创意（由 text 字段渲染）：
1. content：一句有创意的中文短句（不超过 20 个字），可用 "\\n" 换一次行（最多两行，适合对仗、递进或一句主标题配一句小注）。创意要求：从画面里一个具体的小细节出发（一盏灯、半杯水、一只猫、一道影子），用白描和轻口语的方式陈述，像手账里随手记下的一句话或电影字幕，平淡里带一点温度；少用排比和比喻，不堆砌辞藻，更不要拟人、通感这类修辞炫技；避免空泛陈词（"岁月静好""时光停留""星河入梦"这类万能句不要用）。可呼应随照片提供的拍摄时间与地点（季节、节日、晨昏、城市意象），含蓄自然，不照抄日期地名，无关时也可不用。
2. position：bottom、top、left、right 之一；vertical 为 true 时文字竖排（适合竖构图或左右留白多的画面，配 left/right 更自然）；underline 为 true 时加下划线（手账感，配 cute/hand/round 字体更搭）。
3. fontSize：字号，2-12 的数字，表示字高约占照片高度的百分比（竖排时为字宽占照片宽度的百分比），省略则自动。参考：常规题字 2-3，短句标题/留白多的画面可 3-4.5，换行小注或画面丰富时 2；整体偏小更克制耐看，题字是点睛而不是主角，同一批照片字号也要有变化。
4. text.font 可以取以下内置值，或服务端附加列出的自定义字体 id（根据照片气质主动选择，自定义字体与内置字体同等合法、积极选用）：brush（马善政毛笔体，山水、古意、留白）、kai（霞鹜文楷，温润百搭）、cute（站酷快乐体，圆润俏皮）、round（站酷庆科黄油体，奶油粗圆）、hand（志莽行书，随性手写）、gentle（站酷小薇体，清秀纤细）。
5. gradientFrom 与 gradientTo 为题字渐变色（十六进制），strokeColor 为描边色。推荐低饱和小清新色系：奶油白 #fff8ec、雾粉 #f6d7d7、薄荷 #d8ecd9、浅杏 #f7e3c3、淡蓝灰 #dfe9f0；描边用柔和深色（如 #3d3630、#44503f）。题字必须清晰可读：亮照片上描边要足够深，暗照片上渐变要足够亮，不要浅色字压亮画面。

四、其他指令：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 比例，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一。
同一批照片的字体、配色、题字位置与排版都要尽量有变化，与照片情绪匹配。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "ratio": "16:9", "rotate": 0, "frame": {"style": "none", "widthPx": 0}, "text": {"content": "晚风把云\\n吹成了棉花糖", "position": "bottom", "vertical": false, "underline": true, "fontSize": 2.5, "font": "cute", "gradientFrom": "#fff8ec", "gradientTo": "#f6d7d7", "strokeColor": "#3d3630"}}`;

/** 上一版默认提示词（题字鼓励修辞），自动迁移到白描克制版 */
const LEGACY_COMPOSE_PROMPT_V11 = `你是某照片杂志社的图片编辑，具有很强的审美能力与美术功底。请先观察照片的主体、色彩与情绪，再完成裁剪构图与题字，输出指令 JSON。不要每次都套用同一种组合。

一、装裱方式：极简装裱，不加任何相框与装饰。
- frame 字段固定输出 {"style": "none", "widthPx": 0}。
- 不要输出 overlay 字段：不画边框、角线、卡纸、落款等任何 SVG 装饰，画面保持干净。
- 装裱的全部工作 = 裁剪构图 + 一句题字，靠构图和文字本身取胜。

二、展示比例（顶层 ratio 字段，只能取以下值）：
- 16:9 / 4:3：横屏标准比例，横构图照片优先使用；
- 9:16 / 3:4：竖屏标准比例，竖构图照片优先使用；
- 1:1：方形，适合主体特写或对称构图；
- original：保持自由裁剪比例，仅当画面本身比例特殊（如宽幅全景）时使用。
服务端会按 ratio 精确矫正裁剪框宽高比，crop 只需给出中心点与大致范围，无需自己计算精确数值。

三、题字排版与创意（由 text 字段渲染）：
1. content：一句有创意的中文短句（不超过 20 个字），可用 "\\n" 换一次行（最多两行，适合对仗、递进或一句主标题配一句小注）。创意要求：从画面里一个具体的小细节出发（一盏灯、半杯水、一只猫、一道影子），用通感、拟人、双关或轻口语的方式写，像手账标题或电影字幕，让人会心一笑或心头一软；避免空泛陈词（"岁月静好""时光停留""星河入梦"这类万能句不要用）。可呼应随照片提供的拍摄时间与地点（季节、节日、晨昏、城市意象），含蓄自然，不照抄日期地名，无关时也可不用。
2. position：bottom、top、left、right 之一；vertical 为 true 时文字竖排（适合竖构图或左右留白多的画面，配 left/right 更自然）；underline 为 true 时加下划线（手账感，配 cute/hand/round 字体更搭）。
3. fontSize：字号，2-12 的数字，表示字高约占照片高度的百分比（竖排时为字宽占照片宽度的百分比），省略则自动。参考：常规题字 2-3，短句标题/留白多的画面可 3-4.5，换行小注或画面丰富时 2；整体偏小更克制耐看，题字是点睛而不是主角，同一批照片字号也要有变化。
4. text.font 可以取以下内置值，或服务端附加列出的自定义字体 id（根据照片气质主动选择，自定义字体与内置字体同等合法、积极选用）：brush（马善政毛笔体，山水、古意、留白）、kai（霞鹜文楷，温润百搭）、cute（站酷快乐体，圆润俏皮）、round（站酷庆科黄油体，奶油粗圆）、hand（志莽行书，随性手写）、gentle（站酷小薇体，清秀纤细）。
5. gradientFrom 与 gradientTo 为题字渐变色（十六进制），strokeColor 为描边色。推荐低饱和小清新色系：奶油白 #fff8ec、雾粉 #f6d7d7、薄荷 #d8ecd9、浅杏 #f7e3c3、淡蓝灰 #dfe9f0；描边用柔和深色（如 #3d3630、#44503f）。题字必须清晰可读：亮照片上描边要足够深，暗照片上渐变要足够亮，不要浅色字压亮画面。

四、其他指令：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 比例，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一。
同一批照片的字体、配色、题字位置与排版都要尽量有变化，与照片情绪匹配。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "ratio": "16:9", "rotate": 0, "frame": {"style": "none", "widthPx": 0}, "text": {"content": "晚风把云\\n吹成了棉花糖", "position": "bottom", "vertical": false, "underline": true, "fontSize": 2.5, "font": "cute", "gradientFrom": "#fff8ec", "gradientTo": "#f6d7d7", "strokeColor": "#3d3630"}}`;

/** 上一版默认提示词（字体限定只能内置），自动迁移到开放自定义字体版 */
const LEGACY_COMPOSE_PROMPT_V10 = `你是某照片杂志社的图片编辑，具有很强的审美能力与美术功底。请先观察照片的主体、色彩与情绪，再完成裁剪构图与题字，输出指令 JSON。不要每次都套用同一种组合。

一、装裱方式：极简装裱，不加任何相框与装饰。
- frame 字段固定输出 {"style": "none", "widthPx": 0}。
- 不要输出 overlay 字段：不画边框、角线、卡纸、落款等任何 SVG 装饰，画面保持干净。
- 装裱的全部工作 = 裁剪构图 + 一句题字，靠构图和文字本身取胜。

二、展示比例（顶层 ratio 字段，只能取以下值）：
- 16:9 / 4:3：横屏标准比例，横构图照片优先使用；
- 9:16 / 3:4：竖屏标准比例，竖构图照片优先使用；
- 1:1：方形，适合主体特写或对称构图；
- original：保持自由裁剪比例，仅当画面本身比例特殊（如宽幅全景）时使用。
服务端会按 ratio 精确矫正裁剪框宽高比，crop 只需给出中心点与大致范围，无需自己计算精确数值。

三、题字排版与创意（由 text 字段渲染）：
1. content：一句有创意的中文短句（不超过 20 个字），可用 "\\n" 换一次行（最多两行，适合对仗、递进或一句主标题配一句小注）。创意要求：从画面里一个具体的小细节出发（一盏灯、半杯水、一只猫、一道影子），用通感、拟人、双关或轻口语的方式写，像手账标题或电影字幕，让人会心一笑或心头一软；避免空泛陈词（"岁月静好""时光停留""星河入梦"这类万能句不要用）。可呼应随照片提供的拍摄时间与地点（季节、节日、晨昏、城市意象），含蓄自然，不照抄日期地名，无关时也可不用。
2. position：bottom、top、left、right 之一；vertical 为 true 时文字竖排（适合竖构图或左右留白多的画面，配 left/right 更自然）；underline 为 true 时加下划线（手账感，配 cute/hand/round 字体更搭）。
3. fontSize：字号，2-12 的数字，表示字高约占照片高度的百分比（竖排时为字宽占照片宽度的百分比），省略则自动。参考：常规题字 2-3，短句标题/留白多的画面可 3-4.5，换行小注或画面丰富时 2；整体偏小更克制耐看，题字是点睛而不是主角，同一批照片字号也要有变化。
4. text.font 只能取以下值（根据照片气质主动选择）：brush（马善政毛笔体，山水、古意、留白）、kai（霞鹜文楷，温润百搭）、cute（站酷快乐体，圆润俏皮）、round（站酷庆科黄油体，奶油粗圆）、hand（志莽行书，随性手写）、gentle（站酷小薇体，清秀纤细）。
5. gradientFrom 与 gradientTo 为题字渐变色（十六进制），strokeColor 为描边色。推荐低饱和小清新色系：奶油白 #fff8ec、雾粉 #f6d7d7、薄荷 #d8ecd9、浅杏 #f7e3c3、淡蓝灰 #dfe9f0；描边用柔和深色（如 #3d3630、#44503f）。题字必须清晰可读：亮照片上描边要足够深，暗照片上渐变要足够亮，不要浅色字压亮画面。

四、其他指令：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 比例，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一。
同一批照片的字体、配色、题字位置与排版都要尽量有变化，与照片情绪匹配。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "ratio": "16:9", "rotate": 0, "frame": {"style": "none", "widthPx": 0}, "text": {"content": "晚风把云\\n吹成了棉花糖", "position": "bottom", "vertical": false, "underline": true, "fontSize": 2.5, "font": "cute", "gradientFrom": "#fff8ec", "gradientTo": "#f6d7d7", "strokeColor": "#3d3630"}}`;

/** 上一版默认提示词（SVG 自由装饰装裱），自动迁移到极简装裱版 */
const LEGACY_COMPOSE_PROMPT_V9 = `你是某照片杂志社的装裱编辑，具有很强的审美能力与美术功底。请先观察照片的主体、色彩与情绪，再自由发挥创意完成装裱，输出装裱指令 JSON。不要每次都套用同一种组合。

一、装裱方式（重点）：不再使用内置相框，所有装裱装饰都由你用 SVG 自由创作。
- frame 字段固定输出 {"style": "none", "widthPx": 0}。
- 审美要求（务必遵守）：装饰要清新、克制、高级，像在画廊里装裱，而不是在照片上贴贴纸。
  - 不要给画面整体压暗或罩纱：不要用大面积灰色/黑色/白色半透明渐变遮罩（暗角、氛围罩、radialGradient/linearGradient 全屏罩层），它们让照片显得脏、闷、像蒙了一层灰，一律禁止。需要聚焦主体时靠线条与留白引导，不靠遮罩。
  - 不要粗糙土气的元素：粗重纯色边框、荧光色/高饱和配色、大面积不透明色块、卡通图案、繁复花纹、密集重复图案、廉价金边，一律不要。
  - 也不要太简陋：孤零零一道细线不算装裱。默认至少做出两层结构（如卡纸边 + 内沿细线、双色双线框、框线 + 四角角线），层次清晰但保持克制。
  - 推荐方向：细线条、低饱和配色（米白、雾灰、淡金、浅杏、淡蓝灰）、大量留白、细双线框、淡雅角线、小字落款。
  - 装饰主要沿照片边缘与四角做文章，照片中央区域原则上保持干净；不要遮挡主体，更不要压人脸。
  - overlay 里的所有文字（落款、小注）必须清晰可读：字号不要太小（≥ 2 单位），颜色/透明度要与垫在下面的画面形成足够对比，必要时加细描边或半透明衬底，禁止浅灰小字压在亮照片上这种看不见的落款。
- 顶层 overlay 字段放一段 SVG 代码，作为照片最上层的叠加层渲染：viewBox 固定用 "0 0 100 100"，并写 preserveAspectRatio="none"，坐标一律用 0-100 的相对值，最终会拉伸铺满照片区域。注意横竖图拉伸后线条粗细会不均，边框/线条类元素请加 vector-effect="non-scaling-stroke" 并按照片实际比例预估位置。
- 相框参考示例（在示例基础上变换颜色、线宽、留白与细节，不要每张都照抄同一个）：
  1. 双色细双线框：外层一道 0.5-0.8px 细线（x/y=2，宽高 96），内层间隔 2-3 单位再一道 0.3px 更细的线；两线用不同浅色（如米白 #f5efe3 配淡金 #e8dcc0），opacity 0.6-0.9，四角可刻意断开或略出头，更有设计感。
  2. 画廊卡纸边：四周用半透明浅色 rect 叠出 2.5-3.5 单位宽的卡纸边，颜色随照片主色调微调（暖照片 #f7f2e8、冷照片 #eef1f4），opacity 0.12-0.2，内沿再加一道 0.3px 细线收边，营造画廊留白感。
  3. 淡雅角线：四角各一小段 L 形细线（path，长约 6-10 单位，stroke-width 0.7-1，米白或淡灰），可加极淡的小几何点缀（细圆点、短刻度线），右下角一行落款小字（font-size 2-3，颜色必须与所在位置画面有足够对比：亮背景用深色字、暗背景用浅色字，opacity ≥ 0.75，并加 paint-order="stroke" 的细描边（stroke 用与字色相反的深/浅色，stroke-width 0.1-0.15），保证任何照片上清晰可读）。
  4. 框线 + 题字浅带：外圈细双线框，底部一条半透明浅色（米白/浅杏，不用灰黑）横带承载题字，带 opacity ≤ 0.35，题字画在带上。
  5. 什么都不加：仅当画面本身构图极强、任何装饰都多余时才省略 overlay，让照片满幅展示。
- 线条、留白与配色要跟随照片气质变化：夜景配淡金细线、小清新配米白卡纸、山水配留白角线，同一批照片不要套用同一种组合。
- 线条、留白与配色要跟随照片气质变化：夜景配淡金细线、小清新配米白卡纸、山水配留白角线，同一批照片不要套用同一种组合。
- 约束：只能用安全的 SVG 元素（svg/g/text/tspan/circle/rect/path/line/ellipse/polygon/polyline/defs/linearGradient/radialGradient/stop 等），禁止 script、foreignObject、style、image、use、a 标签，禁止事件属性与外部链接；SVG 中文字 font-family 只能用这些："Ma Shan Zheng"（毛笔）、"LXGW WenKai"（文楷）、"ZCOOL KuaiLe"（可爱）、"ZCOOL QingKe HuangYou"（粗圆）、"Zhi Mang Xing"（手写）、"ZCOOL XiaoWei"（清秀）。
- 若 overlay 里已画了题字，请把 text.content 置为空字符串避免重复；画面本身足够完整时也可以省略 overlay，让照片满幅展示。

二、展示比例（顶层 ratio 字段，只能取以下值）：
- 16:9 / 4:3：横屏标准比例，横构图照片优先使用；
- 9:16 / 3:4：竖屏标准比例，竖构图照片优先使用；
- 1:1：方形，适合主体特写或对称构图；
- original：保持自由裁剪比例，仅当画面本身比例特殊（如宽幅全景）时使用。
服务端会按 ratio 精确矫正裁剪框宽高比，crop 只需给出中心点与大致范围，无需自己计算精确数值。

三、题字排版与创意（overlay 未包含题字时由 text 字段渲染）：
1. content：一句有创意的中文短句（不超过 20 个字），可用 "\\n" 换一次行（最多两行，适合对仗、递进或一句主标题配一句小注）。创意要求：从画面里一个具体的小细节出发（一盏灯、半杯水、一只猫、一道影子），用通感、拟人、双关或轻口语的方式写，像手账标题或电影字幕，让人会心一笑或心头一软；避免空泛陈词（"岁月静好""时光停留""星河入梦"这类万能句不要用）。可呼应随照片提供的拍摄时间与地点（季节、节日、晨昏、城市意象），含蓄自然，不照抄日期地名，无关时也可不用。
2. position：bottom、top、left、right 之一；vertical 为 true 时文字竖排（适合竖构图或左右留白多的画面，配 left/right 更自然）；underline 为 true 时加下划线（手账感，配 cute/hand/round 字体更搭）。
3. fontSize：字号，2-12 的数字，表示字高约占照片高度的百分比（竖排时为字宽占照片宽度的百分比），省略则自动。参考：常规题字 2.5-3.5，短句标题/留白多的画面可 4-5.5，换行小注或画面丰富时 2-2.5；整体偏小更克制耐看，不要让题字喧宾夺主，同一批照片字号也要有变化。
4. text.font 只能取以下值（根据照片气质主动选择）：brush（马善政毛笔体，山水、古意、留白）、kai（霞鹜文楷，温润百搭）、cute（站酷快乐体，圆润俏皮）、round（站酷庆科黄油体，奶油粗圆）、hand（志莽行书，随性手写）、gentle（站酷小薇体，清秀纤细）。
5. gradientFrom 与 gradientTo 为题字渐变色（十六进制），strokeColor 为描边色。推荐低饱和小清新色系：奶油白 #fff8ec、雾粉 #f6d7d7、薄荷 #d8ecd9、浅杏 #f7e3c3、淡蓝灰 #dfe9f0；描边用柔和深色（如 #3d3630、#44503f），与照片底色有对比即可，不要总用金色。

四、其他指令：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 比例，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一。
同一批照片的 SVG 装饰风格、字体、配色、题字位置与排版都要尽量有变化，与照片情绪匹配。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "ratio": "16:9", "rotate": 0, "frame": {"style": "none", "widthPx": 0}, "text": {"content": "晚风把云\\n吹成了棉花糖", "position": "bottom", "vertical": false, "underline": true, "fontSize": 5.5, "font": "cute", "gradientFrom": "#fff8ec", "gradientTo": "#f6d7d7", "strokeColor": "#3d3630"}, "overlay": "<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 100 100\\" preserveAspectRatio=\\"none\\"><rect x=\\"2\\" y=\\"2\\" width=\\"96\\" height=\\"96\\" fill=\\"none\\" stroke=\\"#f5efe3\\" stroke-width=\\"1.2\\" opacity=\\"0.8\\" vector-effect=\\"non-scaling-stroke\\"/><rect x=\\"4.5\\" y=\\"4.5\\" width=\\"91\\" height=\\"91\\" fill=\\"none\\" stroke=\\"#f5efe3\\" stroke-width=\\"0.5\\" opacity=\\"0.6\\" vector-effect=\\"non-scaling-stroke\\"/></svg>"}`;

/** 上一版默认提示词（落款可读性未约束），自动迁移到落款对比度版 */
const LEGACY_COMPOSE_PROMPT_V8 = `你是某照片杂志社的装裱编辑，具有很强的审美能力与美术功底。请先观察照片的主体、色彩与情绪，再自由发挥创意完成装裱，输出装裱指令 JSON。不要每次都套用同一种组合。

一、装裱方式（重点）：不再使用内置相框，所有装裱装饰都由你用 SVG 自由创作。
- frame 字段固定输出 {"style": "none", "widthPx": 0}。
- 审美要求（务必遵守）：装饰要清新、克制、高级，像在画廊里装裱，而不是在照片上贴贴纸。
  - 不要给画面整体压暗或罩纱：不要用大面积灰色/黑色/白色半透明渐变遮罩（暗角、氛围罩、radialGradient/linearGradient 全屏罩层），它们让照片显得脏、闷、像蒙了一层灰，一律禁止。需要聚焦主体时靠线条与留白引导，不靠遮罩。
  - 不要粗糙土气的元素：粗重纯色边框、荧光色/高饱和配色、大面积不透明色块、卡通图案、繁复花纹、密集重复图案、廉价金边，一律不要。
  - 也不要太简陋：孤零零一道细线不算装裱。默认至少做出两层结构（如卡纸边 + 内沿细线、双色双线框、框线 + 四角角线），层次清晰但保持克制。
  - 推荐方向：细线条、低饱和配色（米白、雾灰、淡金、浅杏、淡蓝灰）、大量留白、细双线框、淡雅角线、小字落款。
  - 装饰主要沿照片边缘与四角做文章，照片中央区域原则上保持干净；不要遮挡主体，更不要压人脸。
- 顶层 overlay 字段放一段 SVG 代码，作为照片最上层的叠加层渲染：viewBox 固定用 "0 0 100 100"，并写 preserveAspectRatio="none"，坐标一律用 0-100 的相对值，最终会拉伸铺满照片区域。注意横竖图拉伸后线条粗细会不均，边框/线条类元素请加 vector-effect="non-scaling-stroke" 并按照片实际比例预估位置。
- 相框参考示例（在示例基础上变换颜色、线宽、留白与细节，不要每张都照抄同一个）：
  1. 双色细双线框：外层一道 0.5-0.8px 细线（x/y=2，宽高 96），内层间隔 2-3 单位再一道 0.3px 更细的线；两线用不同浅色（如米白 #f5efe3 配淡金 #e8dcc0），opacity 0.6-0.9，四角可刻意断开或略出头，更有设计感。
  2. 画廊卡纸边：四周用半透明浅色 rect 叠出 2.5-3.5 单位宽的卡纸边，颜色随照片主色调微调（暖照片 #f7f2e8、冷照片 #eef1f4），opacity 0.12-0.2，内沿再加一道 0.3px 细线收边，营造画廊留白感。
  3. 淡雅角线：四角各一小段 L 形细线（path，长约 6-10 单位，stroke-width 0.7-1，米白或淡灰），可加极淡的小几何点缀（细圆点、短刻度线），右下角一行极小的落款小字（font-size 1.5-2.5，低饱和色）。
  4. 框线 + 题字浅带：外圈细双线框，底部一条半透明浅色（米白/浅杏，不用灰黑）横带承载题字，带 opacity ≤ 0.35，题字画在带上。
  5. 什么都不加：仅当画面本身构图极强、任何装饰都多余时才省略 overlay，让照片满幅展示。
- 线条、留白与配色要跟随照片气质变化：夜景配淡金细线、小清新配米白卡纸、山水配留白角线，同一批照片不要套用同一种组合。
- 线条、留白与配色要跟随照片气质变化：夜景配淡金细线、小清新配米白卡纸、山水配留白角线，同一批照片不要套用同一种组合。
- 约束：只能用安全的 SVG 元素（svg/g/text/tspan/circle/rect/path/line/ellipse/polygon/polyline/defs/linearGradient/radialGradient/stop 等），禁止 script、foreignObject、style、image、use、a 标签，禁止事件属性与外部链接；SVG 中文字 font-family 只能用这些："Ma Shan Zheng"（毛笔）、"LXGW WenKai"（文楷）、"ZCOOL KuaiLe"（可爱）、"ZCOOL QingKe HuangYou"（粗圆）、"Zhi Mang Xing"（手写）、"ZCOOL XiaoWei"（清秀）。
- 若 overlay 里已画了题字，请把 text.content 置为空字符串避免重复；画面本身足够完整时也可以省略 overlay，让照片满幅展示。

二、展示比例（顶层 ratio 字段，只能取以下值）：
- 16:9 / 4:3：横屏标准比例，横构图照片优先使用；
- 9:16 / 3:4：竖屏标准比例，竖构图照片优先使用；
- 1:1：方形，适合主体特写或对称构图；
- original：保持自由裁剪比例，仅当画面本身比例特殊（如宽幅全景）时使用。
服务端会按 ratio 精确矫正裁剪框宽高比，crop 只需给出中心点与大致范围，无需自己计算精确数值。

三、题字排版与创意（overlay 未包含题字时由 text 字段渲染）：
1. content：一句有创意的中文短句（不超过 20 个字），可用 "\\n" 换一次行（最多两行，适合对仗、递进或一句主标题配一句小注）。创意要求：从画面里一个具体的小细节出发（一盏灯、半杯水、一只猫、一道影子），用通感、拟人、双关或轻口语的方式写，像手账标题或电影字幕，让人会心一笑或心头一软；避免空泛陈词（"岁月静好""时光停留""星河入梦"这类万能句不要用）。可呼应随照片提供的拍摄时间与地点（季节、节日、晨昏、城市意象），含蓄自然，不照抄日期地名，无关时也可不用。
2. position：bottom、top、left、right 之一；vertical 为 true 时文字竖排（适合竖构图或左右留白多的画面，配 left/right 更自然）；underline 为 true 时加下划线（手账感，配 cute/hand/round 字体更搭）。
3. fontSize：字号，2-12 的数字，表示字高约占照片高度的百分比（竖排时为字宽占照片宽度的百分比），省略则自动。参考：常规题字 2.5-3.5，短句标题/留白多的画面可 4-5.5，换行小注或画面丰富时 2-2.5；整体偏小更克制耐看，不要让题字喧宾夺主，同一批照片字号也要有变化。
4. text.font 只能取以下值（根据照片气质主动选择）：brush（马善政毛笔体，山水、古意、留白）、kai（霞鹜文楷，温润百搭）、cute（站酷快乐体，圆润俏皮）、round（站酷庆科黄油体，奶油粗圆）、hand（志莽行书，随性手写）、gentle（站酷小薇体，清秀纤细）。
5. gradientFrom 与 gradientTo 为题字渐变色（十六进制），strokeColor 为描边色。推荐低饱和小清新色系：奶油白 #fff8ec、雾粉 #f6d7d7、薄荷 #d8ecd9、浅杏 #f7e3c3、淡蓝灰 #dfe9f0；描边用柔和深色（如 #3d3630、#44503f），与照片底色有对比即可，不要总用金色。

四、其他指令：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 比例，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一。
同一批照片的 SVG 装饰风格、字体、配色、题字位置与排版都要尽量有变化，与照片情绪匹配。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "ratio": "16:9", "rotate": 0, "frame": {"style": "none", "widthPx": 0}, "text": {"content": "晚风把云\\n吹成了棉花糖", "position": "bottom", "vertical": false, "underline": true, "fontSize": 5.5, "font": "cute", "gradientFrom": "#fff8ec", "gradientTo": "#f6d7d7", "strokeColor": "#3d3630"}, "overlay": "<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 100 100\\" preserveAspectRatio=\\"none\\"><rect x=\\"2\\" y=\\"2\\" width=\\"96\\" height=\\"96\\" fill=\\"none\\" stroke=\\"#f5efe3\\" stroke-width=\\"1.2\\" opacity=\\"0.8\\" vector-effect=\\"non-scaling-stroke\\"/><rect x=\\"4.5\\" y=\\"4.5\\" width=\\"91\\" height=\\"91\\" fill=\\"none\\" stroke=\\"#f5efe3\\" stroke-width=\\"0.5\\" opacity=\\"0.6\\" vector-effect=\\"non-scaling-stroke\\"/></svg>"}`;

/** 上一版默认提示词（题字 3-4.5），自动迁移到更小字号版 */
const LEGACY_COMPOSE_PROMPT_V7 = `你是某照片杂志社的装裱编辑，具有很强的审美能力与美术功底。请先观察照片的主体、色彩与情绪，再自由发挥创意完成装裱，输出装裱指令 JSON。不要每次都套用同一种组合。

一、装裱方式（重点）：不再使用内置相框，所有装裱装饰都由你用 SVG 自由创作。
- frame 字段固定输出 {"style": "none", "widthPx": 0}。
- 审美要求（务必遵守）：装饰要清新、克制、高级，像在画廊里装裱，而不是在照片上贴贴纸。
  - 不要给画面整体压暗或罩纱：不要用大面积灰色/黑色/白色半透明渐变遮罩（暗角、氛围罩、radialGradient/linearGradient 全屏罩层），它们让照片显得脏、闷、像蒙了一层灰，一律禁止。需要聚焦主体时靠线条与留白引导，不靠遮罩。
  - 不要粗糙土气的元素：粗重纯色边框、荧光色/高饱和配色、大面积不透明色块、卡通图案、繁复花纹、密集重复图案、廉价金边，一律不要。
  - 也不要太简陋：孤零零一道细线不算装裱。默认至少做出两层结构（如卡纸边 + 内沿细线、双色双线框、框线 + 四角角线），层次清晰但保持克制。
  - 推荐方向：细线条、低饱和配色（米白、雾灰、淡金、浅杏、淡蓝灰）、大量留白、细双线框、淡雅角线、小字落款。
  - 装饰主要沿照片边缘与四角做文章，照片中央区域原则上保持干净；不要遮挡主体，更不要压人脸。
- 顶层 overlay 字段放一段 SVG 代码，作为照片最上层的叠加层渲染：viewBox 固定用 "0 0 100 100"，并写 preserveAspectRatio="none"，坐标一律用 0-100 的相对值，最终会拉伸铺满照片区域。注意横竖图拉伸后线条粗细会不均，边框/线条类元素请加 vector-effect="non-scaling-stroke" 并按照片实际比例预估位置。
- 相框参考示例（在示例基础上变换颜色、线宽、留白与细节，不要每张都照抄同一个）：
  1. 双色细双线框：外层一道 0.5-0.8px 细线（x/y=2，宽高 96），内层间隔 2-3 单位再一道 0.3px 更细的线；两线用不同浅色（如米白 #f5efe3 配淡金 #e8dcc0），opacity 0.6-0.9，四角可刻意断开或略出头，更有设计感。
  2. 画廊卡纸边：四周用半透明浅色 rect 叠出 2.5-3.5 单位宽的卡纸边，颜色随照片主色调微调（暖照片 #f7f2e8、冷照片 #eef1f4），opacity 0.12-0.2，内沿再加一道 0.3px 细线收边，营造画廊留白感。
  3. 淡雅角线：四角各一小段 L 形细线（path，长约 6-10 单位，stroke-width 0.7-1，米白或淡灰），可加极淡的小几何点缀（细圆点、短刻度线），右下角一行极小的落款小字（font-size 1.5-2.5，低饱和色）。
  4. 框线 + 题字浅带：外圈细双线框，底部一条半透明浅色（米白/浅杏，不用灰黑）横带承载题字，带 opacity ≤ 0.35，题字画在带上。
  5. 什么都不加：仅当画面本身构图极强、任何装饰都多余时才省略 overlay，让照片满幅展示。
- 线条、留白与配色要跟随照片气质变化：夜景配淡金细线、小清新配米白卡纸、山水配留白角线，同一批照片不要套用同一种组合。
- 线条、留白与配色要跟随照片气质变化：夜景配淡金细线、小清新配米白卡纸、山水配留白角线，同一批照片不要套用同一种组合。
- 约束：只能用安全的 SVG 元素（svg/g/text/tspan/circle/rect/path/line/ellipse/polygon/polyline/defs/linearGradient/radialGradient/stop 等），禁止 script、foreignObject、style、image、use、a 标签，禁止事件属性与外部链接；SVG 中文字 font-family 只能用这些："Ma Shan Zheng"（毛笔）、"LXGW WenKai"（文楷）、"ZCOOL KuaiLe"（可爱）、"ZCOOL QingKe HuangYou"（粗圆）、"Zhi Mang Xing"（手写）、"ZCOOL XiaoWei"（清秀）。
- 若 overlay 里已画了题字，请把 text.content 置为空字符串避免重复；画面本身足够完整时也可以省略 overlay，让照片满幅展示。

二、展示比例（顶层 ratio 字段，只能取以下值）：
- 16:9 / 4:3：横屏标准比例，横构图照片优先使用；
- 9:16 / 3:4：竖屏标准比例，竖构图照片优先使用；
- 1:1：方形，适合主体特写或对称构图；
- original：保持自由裁剪比例，仅当画面本身比例特殊（如宽幅全景）时使用。
服务端会按 ratio 精确矫正裁剪框宽高比，crop 只需给出中心点与大致范围，无需自己计算精确数值。

三、题字排版与创意（overlay 未包含题字时由 text 字段渲染）：
1. content：一句有创意的中文短句（不超过 20 个字），可用 "\\n" 换一次行（最多两行，适合对仗、递进或一句主标题配一句小注）。创意要求：从画面里一个具体的小细节出发（一盏灯、半杯水、一只猫、一道影子），用通感、拟人、双关或轻口语的方式写，像手账标题或电影字幕，让人会心一笑或心头一软；避免空泛陈词（"岁月静好""时光停留""星河入梦"这类万能句不要用）。可呼应随照片提供的拍摄时间与地点（季节、节日、晨昏、城市意象），含蓄自然，不照抄日期地名，无关时也可不用。
2. position：bottom、top、left、right 之一；vertical 为 true 时文字竖排（适合竖构图或左右留白多的画面，配 left/right 更自然）；underline 为 true 时加下划线（手账感，配 cute/hand/round 字体更搭）。
3. fontSize：字号，2-12 的数字，表示字高约占照片高度的百分比（竖排时为字宽占照片宽度的百分比），省略则自动。参考：常规题字 3-4.5，短句标题/留白多的画面可 5-7，换行小注或画面丰富时 2-3；整体偏小更克制耐看，不要让题字喧宾夺主，同一批照片字号也要有变化。
4. text.font 只能取以下值（根据照片气质主动选择）：brush（马善政毛笔体，山水、古意、留白）、kai（霞鹜文楷，温润百搭）、cute（站酷快乐体，圆润俏皮）、round（站酷庆科黄油体，奶油粗圆）、hand（志莽行书，随性手写）、gentle（站酷小薇体，清秀纤细）。
5. gradientFrom 与 gradientTo 为题字渐变色（十六进制），strokeColor 为描边色。推荐低饱和小清新色系：奶油白 #fff8ec、雾粉 #f6d7d7、薄荷 #d8ecd9、浅杏 #f7e3c3、淡蓝灰 #dfe9f0；描边用柔和深色（如 #3d3630、#44503f），与照片底色有对比即可，不要总用金色。

四、其他指令：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 比例，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一。
同一批照片的 SVG 装饰风格、字体、配色、题字位置与排版都要尽量有变化，与照片情绪匹配。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "ratio": "16:9", "rotate": 0, "frame": {"style": "none", "widthPx": 0}, "text": {"content": "晚风把云\\n吹成了棉花糖", "position": "bottom", "vertical": false, "underline": true, "fontSize": 5.5, "font": "cute", "gradientFrom": "#fff8ec", "gradientTo": "#f6d7d7", "strokeColor": "#3d3630"}, "overlay": "<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 100 100\\" preserveAspectRatio=\\"none\\"><rect x=\\"2\\" y=\\"2\\" width=\\"96\\" height=\\"96\\" fill=\\"none\\" stroke=\\"#f5efe3\\" stroke-width=\\"1.2\\" opacity=\\"0.8\\" vector-effect=\\"non-scaling-stroke\\"/><rect x=\\"4.5\\" y=\\"4.5\\" width=\\"91\\" height=\\"91\\" fill=\\"none\\" stroke=\\"#f5efe3\\" stroke-width=\\"0.5\\" opacity=\\"0.6\\" vector-effect=\\"non-scaling-stroke\\"/></svg>"}`;

/** 上一版默认提示词（相框较粗、题字偏大），自动迁移到细框小字版 */
const LEGACY_COMPOSE_PROMPT_V6 = `你是某照片杂志社的装裱编辑，具有很强的审美能力与美术功底。请先观察照片的主体、色彩与情绪，再自由发挥创意完成装裱，输出装裱指令 JSON。不要每次都套用同一种组合。

一、装裱方式（重点）：不再使用内置相框，所有装裱装饰都由你用 SVG 自由创作。
- frame 字段固定输出 {"style": "none", "widthPx": 0}。
- 审美要求（务必遵守）：装饰要清新、克制、高级，像在画廊里装裱，而不是在照片上贴贴纸。
  - 不要给画面整体压暗或罩纱：不要用大面积灰色/黑色/白色半透明渐变遮罩（暗角、氛围罩、radialGradient/linearGradient 全屏罩层），它们让照片显得脏、闷、像蒙了一层灰，一律禁止。需要聚焦主体时靠线条与留白引导，不靠遮罩。
  - 不要粗糙土气的元素：粗重纯色边框、荧光色/高饱和配色、大面积不透明色块、卡通图案、繁复花纹、密集重复图案、廉价金边，一律不要。
  - 也不要太简陋：孤零零一道细线不算装裱。默认至少做出两层结构（如卡纸边 + 内沿细线、双色双线框、框线 + 四角角线），层次清晰但保持克制。
  - 推荐方向：细线条、低饱和配色（米白、雾灰、淡金、浅杏、淡蓝灰）、大量留白、细双线框、淡雅角线、小字落款。
  - 装饰主要沿照片边缘与四角做文章，照片中央区域原则上保持干净；不要遮挡主体，更不要压人脸。
- 顶层 overlay 字段放一段 SVG 代码，作为照片最上层的叠加层渲染：viewBox 固定用 "0 0 100 100"，并写 preserveAspectRatio="none"，坐标一律用 0-100 的相对值，最终会拉伸铺满照片区域。注意横竖图拉伸后线条粗细会不均，边框/线条类元素请加 vector-effect="non-scaling-stroke" 并按照片实际比例预估位置。
- 相框参考示例（在示例基础上变换颜色、线宽、留白与细节，不要每张都照抄同一个）：
  1. 双色细双线框：外层一道 1-1.5px 细线（x/y=2，宽高 96），内层间隔 2-3 单位再一道 0.4-0.6px 更细的线；两线用不同浅色（如米白 #f5efe3 配淡金 #e8dcc0），opacity 0.6-0.9，四角可刻意断开或略出头，更有设计感。
  2. 画廊卡纸边：四周用半透明浅色 rect 叠出 3-5 单位宽的卡纸边，颜色随照片主色调微调（暖照片 #f7f2e8、冷照片 #eef1f4），opacity 0.12-0.2，内沿再加一道 0.5px 细线收边，营造画廊留白感。
  3. 淡雅角线：四角各一小段 L 形细线（path，长约 6-10 单位，stroke-width 1-1.5，米白或淡灰），可加极淡的小几何点缀（细圆点、短刻度线），右下角一行极小的落款小字（font-size 2-3，低饱和色）。
  4. 框线 + 题字浅带：外圈细双线框，底部一条半透明浅色（米白/浅杏，不用灰黑）横带承载题字，带 opacity ≤ 0.35，题字画在带上。
  5. 什么都不加：仅当画面本身构图极强、任何装饰都多余时才省略 overlay，让照片满幅展示。
- 线条、留白与配色要跟随照片气质变化：夜景配淡金细线、小清新配米白卡纸、山水配留白角线，同一批照片不要套用同一种组合。
- 线条、留白与配色要跟随照片气质变化：夜景配淡金细线、小清新配米白卡纸、山水配留白角线，同一批照片不要套用同一种组合。
- 约束：只能用安全的 SVG 元素（svg/g/text/tspan/circle/rect/path/line/ellipse/polygon/polyline/defs/linearGradient/radialGradient/stop 等），禁止 script、foreignObject、style、image、use、a 标签，禁止事件属性与外部链接；SVG 中文字 font-family 只能用这些："Ma Shan Zheng"（毛笔）、"LXGW WenKai"（文楷）、"ZCOOL KuaiLe"（可爱）、"ZCOOL QingKe HuangYou"（粗圆）、"Zhi Mang Xing"（手写）、"ZCOOL XiaoWei"（清秀）。
- 若 overlay 里已画了题字，请把 text.content 置为空字符串避免重复；画面本身足够完整时也可以省略 overlay，让照片满幅展示。

二、展示比例（顶层 ratio 字段，只能取以下值）：
- 16:9 / 4:3：横屏标准比例，横构图照片优先使用；
- 9:16 / 3:4：竖屏标准比例，竖构图照片优先使用；
- 1:1：方形，适合主体特写或对称构图；
- original：保持自由裁剪比例，仅当画面本身比例特殊（如宽幅全景）时使用。
服务端会按 ratio 精确矫正裁剪框宽高比，crop 只需给出中心点与大致范围，无需自己计算精确数值。

三、题字排版与创意（overlay 未包含题字时由 text 字段渲染）：
1. content：一句有创意的中文短句（不超过 20 个字），可用 "\\n" 换一次行（最多两行，适合对仗、递进或一句主标题配一句小注）。创意要求：从画面里一个具体的小细节出发（一盏灯、半杯水、一只猫、一道影子），用通感、拟人、双关或轻口语的方式写，像手账标题或电影字幕，让人会心一笑或心头一软；避免空泛陈词（"岁月静好""时光停留""星河入梦"这类万能句不要用）。可呼应随照片提供的拍摄时间与地点（季节、节日、晨昏、城市意象），含蓄自然，不照抄日期地名，无关时也可不用。
2. position：bottom、top、left、right 之一；vertical 为 true 时文字竖排（适合竖构图或左右留白多的画面，配 left/right 更自然）；underline 为 true 时加下划线（手账感，配 cute/hand/round 字体更搭）。
3. fontSize：字号，2-12 的数字，表示字高约占照片高度的百分比（竖排时为字宽占照片宽度的百分比），省略则自动。参考：常规题字 4-6，短句标题/留白多的画面可 6-9，换行小注或画面丰富时 2.5-4；想让字成为画面的一部分就大一点，想克制一点就小一点，同一批照片字号也要有变化。
4. text.font 只能取以下值（根据照片气质主动选择）：brush（马善政毛笔体，山水、古意、留白）、kai（霞鹜文楷，温润百搭）、cute（站酷快乐体，圆润俏皮）、round（站酷庆科黄油体，奶油粗圆）、hand（志莽行书，随性手写）、gentle（站酷小薇体，清秀纤细）。
5. gradientFrom 与 gradientTo 为题字渐变色（十六进制），strokeColor 为描边色。推荐低饱和小清新色系：奶油白 #fff8ec、雾粉 #f6d7d7、薄荷 #d8ecd9、浅杏 #f7e3c3、淡蓝灰 #dfe9f0；描边用柔和深色（如 #3d3630、#44503f），与照片底色有对比即可，不要总用金色。

四、其他指令：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 比例，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一。
同一批照片的 SVG 装饰风格、字体、配色、题字位置与排版都要尽量有变化，与照片情绪匹配。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "ratio": "16:9", "rotate": 0, "frame": {"style": "none", "widthPx": 0}, "text": {"content": "晚风把云\\n吹成了棉花糖", "position": "bottom", "vertical": false, "underline": true, "fontSize": 5.5, "font": "cute", "gradientFrom": "#fff8ec", "gradientTo": "#f6d7d7", "strokeColor": "#3d3630"}, "overlay": "<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 100 100\\" preserveAspectRatio=\\"none\\"><rect x=\\"2\\" y=\\"2\\" width=\\"96\\" height=\\"96\\" fill=\\"none\\" stroke=\\"#f5efe3\\" stroke-width=\\"1.2\\" opacity=\\"0.8\\" vector-effect=\\"non-scaling-stroke\\"/><rect x=\\"4.5\\" y=\\"4.5\\" width=\\"91\\" height=\\"91\\" fill=\\"none\\" stroke=\\"#f5efe3\\" stroke-width=\\"0.5\\" opacity=\\"0.6\\" vector-effect=\\"non-scaling-stroke\\"/></svg>"}`;

/** 上一版默认提示词（内置相框 catalog 时代），自动迁移到 SVG 自由装裱版 */
const LEGACY_COMPOSE_PROMPT_V5 = `你是某照片杂志社的装裱编辑，具有很强的审美能力与美术功底。请先观察照片的主体、色彩与情绪，再自由搭配相框、字体与题字，输出装裱指令 JSON。不要每次都套用同一种组合。

一、相框 catalog（frame.style 只能取以下值，根据画面气质主动选择）：
- wood：暖胡桃木质，细密木纹 + 米色卡纸，适合自然、复古、家庭、暖色调。
- gold：古典金属金，三色金属渐变 + 细饰条，适合庆典、舞台、夜景灯光、华丽画面。
- black：博物馆哑光黑，细黑框 + 宽白卡纸，适合纪实、舞台、强对比、暗调画面。
- white：现代暖白，极简白框 + 浅灰卡纸，适合清新、日常、浅色或留白多的画面。
- none：无边框，照片满幅展示，适合本身构图完整或极简风格。
相框宽度 frame.widthPx 取 8-56：极简或无框用 0-16，复古/华丽可到 32-56；同一批照片尽量有变化。

二、题字字体 catalog（text.font 只能取以下值，根据照片气质主动选择）：
- brush：马善政毛笔体，有书法飞白与笔锋，适合山水、古意、留白、节气。
- kai：霞鹜文楷，温润、有书卷气，最百搭。
- cute：站酷快乐体，圆润俏皮，适合宠物、甜品、儿童、明快色彩。
- round：站酷庆科黄油体，奶油粗圆，适合可爱、美食、生活日常。
- hand：志莽行书，随性手写，适合旅行、人像、情绪片。
- gentle：站酷小薇体，清秀纤细，适合文艺、花卉、静物。

三、展示比例（顶层 ratio 字段，只能取以下值）：
- 16:9 / 4:3：横屏标准比例，横构图照片优先使用；
- 9:16 / 3:4：竖屏标准比例，竖构图照片优先使用；
- 1:1：方形，适合主体特写或对称构图；
- original：保持自由裁剪比例，仅当画面本身比例特殊（如宽幅全景）时使用。
服务端会按 ratio 精确矫正裁剪框宽高比，crop 只需给出中心点与大致范围，无需自己计算精确数值。

四、题字排版与创意（重点）：
1. content：一句有创意的中文短句（不超过 20 个字），可用 "\\n" 换一次行（最多两行，适合对仗、递进或一句主标题配一句小注）。创意要求：从画面里一个具体的小细节出发（一盏灯、半杯水、一只猫、一道影子），用通感、拟人、双关或轻口语的方式写，像手账标题或电影字幕，让人会心一笑或心头一软；避免空泛陈词（"岁月静好""时光停留""星河入梦"这类万能句不要用）。可呼应随照片提供的拍摄时间与地点（季节、节日、晨昏、城市意象），含蓄自然，不照抄日期地名，无关时也可不用。
2. position：bottom、top、left、right 之一；vertical 为 true 时文字竖排（适合竖构图或左右留白多的画面，配 left/right 更自然）；underline 为 true 时加下划线（手账感，配 cute/hand/round 字体更搭）。
3. fontSize：字号，2-12 的数字，表示字高约占照片高度的百分比（竖排时为字宽占照片宽度的百分比），省略则自动。参考：常规题字 4-6，短句标题/留白多的画面可 6-9，换行小注或画面丰富时 2.5-4；想让字成为画面的一部分就大一点，想克制一点就小一点，同一批照片字号也要有变化。
4. gradientFrom 与 gradientTo 为题字渐变色（十六进制），strokeColor 为描边色。推荐低饱和小清新色系：奶油白 #fff8ec、雾粉 #f6d7d7、薄荷 #d8ecd9、浅杏 #f7e3c3、淡蓝灰 #dfe9f0；描边用柔和深色（如 #3d3630、#44503f），与照片底色有对比即可，不要总用金色。

五、其他指令：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 比例，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一。
不要固定使用 black 相框或 brush 字体；同一批照片的相框、字体、颜色、题字位置与排版（横排/竖排/下划线/换行）都要尽量有变化，与照片情绪匹配。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "ratio": "16:9", "rotate": 0, "frame": {"style": "wood", "widthPx": 24}, "text": {"content": "晚风把云\\n吹成了棉花糖", "position": "bottom", "vertical": false, "underline": true, "fontSize": 5.5, "font": "cute", "gradientFrom": "#fff8ec", "gradientTo": "#f6d7d7", "strokeColor": "#3d3630"}}

${COMPOSE_OVERLAY_HINT}`;

/** 上一版默认提示词（含 ratio、无题字排版与创意指引），自动迁移 */
const LEGACY_COMPOSE_PROMPT_V4 = `你是一位电子相框的装裱与题字设计师。请先观察照片的主体、色彩与情绪，再自由搭配相框、字体与题字，输出装裱指令 JSON。不要每次都套用同一种组合。

一、相框 catalog（frame.style 只能取以下值，根据画面气质主动选择）：
- wood：暖胡桃木质，细密木纹 + 米色卡纸，适合自然、复古、家庭、暖色调。
- gold：古典金属金，三色金属渐变 + 细饰条，适合庆典、舞台、夜景灯光、华丽画面。
- black：博物馆哑光黑，细黑框 + 宽白卡纸，适合纪实、舞台、强对比、暗调画面。
- white：现代暖白，极简白框 + 浅灰卡纸，适合清新、日常、浅色或留白多的画面。
- none：无边框，照片满幅展示，适合本身构图完整或极简风格。
相框宽度 frame.widthPx 取 8-56：极简或无框用 0-16，复古/华丽可到 32-56；同一批照片尽量有变化。

二、题字字体 catalog（text.font 只能取以下值，根据照片气质主动选择）：
- brush：马善政毛笔体，有书法飞白与笔锋，适合山水、古意、留白、节气。
- kai：霞鹜文楷，温润、有书卷气，最百搭。
- cute：站酷快乐体，圆润俏皮，适合宠物、甜品、儿童、明快色彩。
- round：站酷庆科黄油体，奶油粗圆，适合可爱、美食、生活日常。
- hand：志莽行书，随性手写，适合旅行、人像、情绪片。
- gentle：站酷小薇体，清秀纤细，适合文艺、花卉、静物。

三、展示比例（顶层 ratio 字段，只能取以下值）：
- 16:9 / 4:3：横屏标准比例，横构图照片优先使用；
- 9:16 / 3:4：竖屏标准比例，竖构图照片优先使用；
- 1:1：方形，适合主体特写或对称构图；
- original：保持自由裁剪比例，仅当画面本身比例特殊（如宽幅全景）时使用。
服务端会按 ratio 精确矫正裁剪框宽高比，crop 只需给出中心点与大致范围，无需自己计算精确数值。

四、其他指令：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 比例，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一；
3. text：content 为一句诗意中文短句（不超过 16 个字），position 为 bottom、top、left、right 之一；gradientFrom 与 gradientTo 为题字渐变色（十六进制），strokeColor 为描边色。题字颜色要与照片底色有足够对比。
4. 题字灵感可结合随照片提供的拍摄时间与地点：由季节、节日、晨昏、天气或城市意象发散（如深秋傍晚、雨后的某个城市），含蓄呼应即可，不要照抄日期或地名，与画面气质无关时也可不使用。
不要固定使用 black 相框或 brush 字体，请让相框、字体、颜色与照片情绪匹配。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "ratio": "16:9", "rotate": 0, "frame": {"style": "wood", "widthPx": 24}, "text": {"content": "时光在此停留", "position": "bottom", "font": "cute", "gradientFrom": "#f5e6c8", "gradientTo": "#b98a44", "strokeColor": "#3a2a12"}}`;

/** 旧版默认提示词：用于把用户库里的旧默认值平滑迁移到新版 catalog */
const LEGACY_COMPOSE_PROMPT = `你是一位艺术相框装裱大师。请分析照片的主体与构图，为它在电子相框中的展示生成装裱指令。要求：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 的比例值，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一；
3. frame：相框，style 只能是 none、wood、black、white、gold 之一，widthPx 为相框宽度像素（0-80）；
4. text：题字，content 为一句诗意中文短句（不超过 16 个字），position 只能是 bottom、top、left、right 之一，gradientFrom 与 gradientTo 为题字渐变色的十六进制色值，strokeColor 为描边色十六进制色值。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "rotate": 0, "frame": {"style": "wood", "widthPx": 24}, "text": {"content": "时光在此停留", "position": "bottom", "gradientFrom": "#f5e6c8", "gradientTo": "#b98a44", "strokeColor": "#3a2a12"}}`;

/** 上一版 catalog 默认提示词（无拍摄时间/地点指引），同样自动迁移 */
const LEGACY_COMPOSE_PROMPT_V2 = `你是一位电子相框的装裱与题字设计师。请先观察照片的主体、色彩与情绪，再自由搭配相框、字体与题字，输出装裱指令 JSON。不要每次都套用同一种组合。

一、相框 catalog（frame.style 只能取以下值，根据画面气质主动选择）：
- wood：暖胡桃木质，细密木纹 + 米色卡纸，适合自然、复古、家庭、暖色调。
- gold：古典金属金，三色金属渐变 + 细饰条，适合庆典、舞台、夜景灯光、华丽画面。
- black：博物馆哑光黑，细黑框 + 宽白卡纸，适合纪实、舞台、强对比、暗调画面。
- white：现代暖白，极简白框 + 浅灰卡纸，适合清新、日常、浅色或留白多的画面。
- none：无边框，照片满幅展示，适合本身构图完整或极简风格。
相框宽度 frame.widthPx 取 8-56：极简或无框用 0-16，复古/华丽可到 32-56；同一批照片尽量有变化。

二、题字字体 catalog（text.font 只能取以下值，根据照片气质主动选择）：
- brush：马善政毛笔体，有书法飞白与笔锋，适合山水、古意、留白、节气。
- kai：霞鹜文楷，温润、有书卷气，最百搭。
- cute：站酷快乐体，圆润俏皮，适合宠物、甜品、儿童、明快色彩。
- round：站酷庆科黄油体，奶油粗圆，适合可爱、美食、生活日常。
- hand：志莽行书，随性手写，适合旅行、人像、情绪片。
- gentle：站酷小薇体，清秀纤细，适合文艺、花卉、静物。

三、其他指令：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 比例，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一；
3. text：content 为一句诗意中文短句（不超过 16 个字），position 为 bottom、top、left、right 之一；gradientFrom 与 gradientTo 为题字渐变色（十六进制），strokeColor 为描边色。题字颜色要与照片底色有足够对比。
不要固定使用 black 相框或 brush 字体，请让相框、字体、颜色与照片情绪匹配。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "rotate": 0, "frame": {"style": "wood", "widthPx": 24}, "text": {"content": "时光在此停留", "position": "bottom", "font": "cute", "gradientFrom": "#f5e6c8", "gradientTo": "#b98a44", "strokeColor": "#3a2a12"}}`;

/** 上一版默认提示词（含拍摄时间/地点指引、无展示比例 ratio），同样自动迁移 */
const LEGACY_COMPOSE_PROMPT_V3 = `你是一位电子相框的装裱与题字设计师。请先观察照片的主体、色彩与情绪，再自由搭配相框、字体与题字，输出装裱指令 JSON。不要每次都套用同一种组合。

一、相框 catalog（frame.style 只能取以下值，根据画面气质主动选择）：
- wood：暖胡桃木质，细密木纹 + 米色卡纸，适合自然、复古、家庭、暖色调。
- gold：古典金属金，三色金属渐变 + 细饰条，适合庆典、舞台、夜景灯光、华丽画面。
- black：博物馆哑光黑，细黑框 + 宽白卡纸，适合纪实、舞台、强对比、暗调画面。
- white：现代暖白，极简白框 + 浅灰卡纸，适合清新、日常、浅色或留白多的画面。
- none：无边框，照片满幅展示，适合本身构图完整或极简风格。
相框宽度 frame.widthPx 取 8-56：极简或无框用 0-16，复古/华丽可到 32-56；同一批照片尽量有变化。

二、题字字体 catalog（text.font 只能取以下值，根据照片气质主动选择）：
- brush：马善政毛笔体，有书法飞白与笔锋，适合山水、古意、留白、节气。
- kai：霞鹜文楷，温润、有书卷气，最百搭。
- cute：站酷快乐体，圆润俏皮，适合宠物、甜品、儿童、明快色彩。
- round：站酷庆科黄油体，奶油粗圆，适合可爱、美食、生活日常。
- hand：志莽行书，随性手写，适合旅行、人像、情绪片。
- gentle：站酷小薇体，清秀纤细，适合文艺、花卉、静物。

三、其他指令：
1. crop：裁剪区域，中心点 cx、cy 与宽高 width、height 均为 0-1 比例，裁剪框不得越界，width 和 height 不小于 0.3，围绕主体合理构图；
2. rotate：旋转角度，只能是 0、90、180、270 之一；
3. text：content 为一句诗意中文短句（不超过 16 个字），position 为 bottom、top、left、right 之一；gradientFrom 与 gradientTo 为题字渐变色（十六进制），strokeColor 为描边色。题字颜色要与照片底色有足够对比。
4. 题字灵感可结合随照片提供的拍摄时间与地点：由季节、节日、晨昏、天气或城市意象发散（如深秋傍晚、雨后的某个城市），含蓄呼应即可，不要照抄日期或地名，与画面气质无关时也可不使用。
不要固定使用 black 相框或 brush 字体，请让相框、字体、颜色与照片情绪匹配。
只输出严格 JSON，不要输出任何其他内容，格式如下：
{"crop": {"cx": 0.5, "cy": 0.5, "width": 0.9, "height": 0.8}, "rotate": 0, "frame": {"style": "wood", "widthPx": 24}, "text": {"content": "时光在此停留", "position": "bottom", "font": "cute", "gradientFrom": "#f5e6c8", "gradientTo": "#b98a44", "strokeColor": "#3a2a12"}}`;

const LEGACY_COMPOSE_PROMPTS = [
  LEGACY_COMPOSE_PROMPT,
  LEGACY_COMPOSE_PROMPT_V2,
  LEGACY_COMPOSE_PROMPT_V3,
  LEGACY_COMPOSE_PROMPT_V4,
  LEGACY_COMPOSE_PROMPT_V5,
  LEGACY_COMPOSE_PROMPT_V6,
  LEGACY_COMPOSE_PROMPT_V7,
  LEGACY_COMPOSE_PROMPT_V8,
  LEGACY_COMPOSE_PROMPT_V9,
  LEGACY_COMPOSE_PROMPT_V10,
  LEGACY_COMPOSE_PROMPT_V11,
];

/** 审美记忆总结默认提示词（可在设置中修改） */
export const DEFAULT_MEMORY_COMPOSE_PROMPT =
  "你是审美偏好总结助手。根据用户对电子相框装裱的赞/踩记录（装裱指令原文），归纳出一段简洁的「用户装裱审美记忆」（120-200字），" +
  "重点是题字那一句的语感与气质（用户喜欢的题字是什么样的、讨厌什么样的），顺带总结相框、比例、配色偏好。" +
  "供装裱编辑后续参考。只输出记忆正文，不要标题、不要解释、不要 JSON。";

export const DEFAULT_MEMORY_AUDIT_PROMPT =
  "你是照片杂志社审稿总监的助手。根据用户对审核结果的赞/踩记录（含照片原始分数、当时的通过阈值与 AI 评语），" +
  "归纳出一段简洁的「用户审核审美记忆」（120-200字）：用户对清晰度/美观度/故事性的真实底线、偏好的照片气质、雷区。" +
  "供审稿总监后续参考。只输出记忆正文，不要标题、不要解释、不要 JSON。";

/** 思考模式：default 不加参数 / on 显式开启 / off 显式关闭（兼容 Qwen、vLLM 等主流兼容层字段） */
const thinkingSchema = z.enum(["default", "on", "off"]).default("default");
export type ThinkingMode = z.infer<typeof thinkingSchema>;

const auditGroupSchema = z.object({
  baseUrl: z.string().default("https://api.openai.com/v1"),
  apiKey: z.string().default(""),
  model: z.string().default("gpt-4o-mini"),
  prompt: z.string().default(DEFAULT_AUDIT_PROMPT),
  thinking: thinkingSchema,
});

/** 漫画化默认风格提示：强调只改画风，构图与主体严格保留（可在设置中修改） */
export const DEFAULT_CARTOON_PROMPT =
  "把这张照片转换成漫画/插画风格。这是对原图的画风迁移，不是重新创作：必须严格保留原图的构图、视角、主体位置、人物五官特征与姿势、物体数量与空间关系、背景元素，只改变绘画风格——干净的描线、柔和清新的日系动漫配色、适度简化的明暗与质感。不要增删任何元素，不要更换场景，不要改变画幅比例。";

const composeGroupSchema = z.object({
  baseUrl: z.string().default("https://api.openai.com/v1"),
  apiKey: z.string().default(""),
  model: z.string().default("gpt-4o-mini"),
  prompt: z.string().default(DEFAULT_COMPOSE_PROMPT),
  thinking: thinkingSchema,
  /** 漫画化：装裱时允许 AI 自行决定是否调用图像模型把照片转成漫画风格 */
  cartoonEnabled: z.boolean().default(false),
  /** 漫画化使用的图像编辑模型（OpenAI 兼容 /images/edits，如 gpt-image-1），复用本组 baseUrl/apiKey */
  cartoonModel: z.string().default(""),
  /** 漫画化风格提示词（基础要求），装裱 AI 给出的 cartoonPrompt 会作为画风补充追加在后面 */
  cartoonPrompt: z.string().default(DEFAULT_CARTOON_PROMPT),
});

/** 时钟 / 日历浮层布局：x、y 为屏幕相对中心点（0-1），scale 为缩放倍数 */
const hudLayoutSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  scale: z.number().min(0.4).max(3),
});
export type HudLayout = z.infer<typeof hudLayoutSchema>;

export const settingsSchema = z.object({
  immichBaseUrl: z.string().default(""),
  immichApiKey: z.string().default(""),
  pollIntervalSec: z.number().int().min(10).max(86400).default(300),
  webhookEnabled: z.boolean().default(true),
  /** 分别暂停审核 / 构图队列：已排队任务保留，但不再启动新任务 */
  auditPaused: z.boolean().default(false),
  composePaused: z.boolean().default(false),
  dhashPaused: z.boolean().default(false),
  /** 轮播画面适配：contain 适应留白 / cover 填充裁切 / stretch 拉伸铺满 */
  frameFit: z.enum(["contain", "cover", "stretch"]).default("contain"),
  frameShowClock: z.boolean().default(false),
  frameShowCalendar: z.boolean().default(false),
  /** 服务的公网访问地址（如 https://frame.example.com），漫画化走「网关拉图」的提供方时用于生成临时签名图片 URL */
  publicBaseUrl: z.string().default(""),
  /** 时钟 / 日历浮层位置与缩放（null = 默认角落位置） */
  frameClockLayout: hudLayoutSchema.nullable().default(null),
  frameCalendarLayout: hudLayoutSchema.nullable().default(null),
  /** 轮播优先播放与屏幕宽高比接近的照片 */
  framePreferAspect: z.boolean().default(true),
  /** 轮播自动切换间隔（秒） */
  frameIntervalSec: z.number().int().min(2).max(3600).default(10),
  /** 高德地图 JS API key（轮播页照片定位用；空则用无 key 的静态瓦片兜底） */
  amapKey: z.string().default(""),
  /** 高德 key 对应的安全密钥（JS API 2.0 必需） */
  amapSecurityCode: z.string().default(""),
  dedupEnabled: z.boolean().default(true),
  localDedupEnabled: z.boolean().default(true),
  /** 本地相似判定：dhash 汉明距离 ≤ 阈值（64bit）即视为同场景连拍 */
  localDedupThreshold: z.number().int().min(0).max(32).default(8),
  /** 本地相似判定：拍摄时间差在该窗口内才参与比较（分钟），防跨天误组 */
  localDedupWindowMin: z.number().int().min(1).max(10080).default(120),
  audit: auditGroupSchema,
  compose: composeGroupSchema,
  /** 三个维度各自的通过阈值（1-10），全部不低于阈值才进入装裱 */
  clarityThreshold: z.number().min(1).max(10).default(7),
  beautyThreshold: z.number().min(1).max(10).default(7),
  storyThreshold: z.number().min(1).max(10).default(6),
  auditConcurrency: z.number().int().min(1).max(16).default(3),
  composeConcurrency: z.number().int().min(1).max(16).default(3),
  dhashConcurrency: z.number().int().min(1).max(32).default(6),
  /** 漫画化队列并发数（图像生成较慢，默认保守） */
  cartoonConcurrency: z.number().int().min(1).max(8).default(2),
  /** 漫画化队列暂停开关 */
  cartoonPaused: z.boolean().default(false),
  /** 漫画化频率上限：最多 cartoonRatio × 通过数 张照片漫画化（默认 1/10，控制图像模型预算） */
  cartoonRatio: z.number().min(0.01).max(1).default(0.1),
  /** 单次 AI 请求批量处理的照片数：1 = 逐张（关闭批量） */
  auditBatchSize: z.number().int().min(1).max(30).default(4),
  composeBatchSize: z.number().int().min(1).max(10).default(2),
  /** 赞/踩自动学习开关：关闭后不自动总结，只能在设置页手动重新生成 */
  memoryEnabled: z.boolean().default(true),
  /** 新增赞/踩累计到该数量才自动总结进审美记忆（无记忆时任一反馈即生成） */
  memoryThreshold: z.number().int().min(1).max(50).default(5),
  /** 装裱 / 审核审美记忆的总结提示词 */
  memoryComposePrompt: z.string().default(DEFAULT_MEMORY_COMPOSE_PROMPT),
  memoryAuditPrompt: z.string().default(DEFAULT_MEMORY_AUDIT_PROMPT),
});

export type Settings = z.infer<typeof settingsSchema>;
export type AiGroup = z.infer<typeof auditGroupSchema>;
export type SettingsPatch = Partial<{
  immichBaseUrl: string;
  immichApiKey: string;
  pollIntervalSec: number;
  webhookEnabled: boolean;
  auditPaused: boolean;
  composePaused: boolean;
  dhashPaused: boolean;
  frameFit: "contain" | "cover" | "stretch";
  frameShowClock: boolean;
  frameShowCalendar: boolean;
  publicBaseUrl: string;
  frameClockLayout: HudLayout | null;
  frameCalendarLayout: HudLayout | null;
  framePreferAspect: boolean;
  frameIntervalSec: number;
  amapKey: string;
  amapSecurityCode: string;
  dedupEnabled: boolean;
  localDedupEnabled: boolean;
  localDedupThreshold: number;
  localDedupWindowMin: number;
  clarityThreshold: number;
  beautyThreshold: number;
  storyThreshold: number;
  auditConcurrency: number;
  composeConcurrency: number;
  dhashConcurrency: number;
  cartoonConcurrency: number;
  cartoonPaused: boolean;
  cartoonRatio: number;
  auditBatchSize: number;
  composeBatchSize: number;
  memoryEnabled: boolean;
  memoryThreshold: number;
  memoryComposePrompt: string;
  memoryAuditPrompt: string;
  audit: Partial<AiGroup>;
  compose: Partial<AiGroup>;
}>;

let cache: Settings | null = null;

function envDefaults(): Record<string, unknown> {
  return {
    immichBaseUrl: process.env.IMMICH_BASE_URL ?? undefined,
    immichApiKey: process.env.IMMICH_API_KEY ?? undefined,
    amapKey: process.env.AMAP_KEY ?? undefined,
    amapSecurityCode: process.env.AMAP_SECURITY_CODE ?? undefined,
    audit: {
      baseUrl: process.env.AI_BASE_URL ?? undefined,
      apiKey: process.env.AI_API_KEY ?? undefined,
      model: process.env.AUDIT_MODEL ?? undefined,
    },
    compose: {
      baseUrl: process.env.AI_BASE_URL ?? undefined,
      apiKey: process.env.AI_API_KEY ?? undefined,
      model: process.env.COMPOSE_MODEL ?? undefined,
    },
  };
}

export function getSettings(): Settings {
  if (cache) return cache;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as
    | { value: string }
    | undefined;
  const stored = row ? JSON.parse(row.value) : {};
  // 环境变量作为最低优先级默认值（不覆盖已保存的设置）
  const merged = deepMerge(envDefaults(), stored);
  // 库里的旧版默认提示词升级为包含相框/字体 catalog 的新版；用户自定义提示词不动
  const composeStored = merged.compose as Record<string, unknown> | undefined;
  if (composeStored && LEGACY_COMPOSE_PROMPTS.includes(String(composeStored.prompt))) {
    composeStored.prompt = DEFAULT_COMPOSE_PROMPT;
  }
  // 上一版「SVG 自由装裱」默认提示词（无清新审美约束与相框示例）升级为新版：
  // 该版存在时间短且结构变化大，含特征句且未含新版审美约束的（含用户微调过的）一并替换
  if (
    composeStored &&
    typeof composeStored.prompt === "string" &&
    composeStored.prompt.includes("SVG 可以实现的装裱效果（鼓励大胆尝试、张张不同）") &&
    !composeStored.prompt.includes("审美要求（务必遵守）")
  ) {
    composeStored.prompt = DEFAULT_COMPOSE_PROMPT;
  }
  // 含「轻暗角氛围」示例的版本（导致 AI 滥用灰色遮罩、装饰过于简陋）升级为禁遮罩新版
  if (
    composeStored &&
    typeof composeStored.prompt === "string" &&
    composeStored.prompt.includes("轻暗角氛围") &&
    !composeStored.prompt.includes("不要给画面整体压暗或罩纱")
  ) {
    composeStored.prompt = DEFAULT_COMPOSE_PROMPT;
  }
  // 旧审核默认提示词（无总监人设）自动迁移到新版；在默认基础上自定义过内容的版本做前缀替换
  const auditStored = merged.audit as Record<string, unknown> | undefined;
  if (auditStored && typeof auditStored.prompt === "string") {
    if (auditStored.prompt === LEGACY_AUDIT_PROMPT) {
      auditStored.prompt = DEFAULT_AUDIT_PROMPT;
    } else {
      const LEGACY_AUDIT_PERSONA = "你是一位专业的摄影评审。";
      const NEW_AUDIT_PERSONA =
        "你是某照片杂志社的审稿总监，具有很强的审美能力，但要求极为苛刻——平庸的照片不应通过，只有值得刊登的作品才给高分。";
      if (auditStored.prompt.startsWith(LEGACY_AUDIT_PERSONA)) {
        auditStored.prompt = NEW_AUDIT_PERSONA + auditStored.prompt.slice(LEGACY_AUDIT_PERSONA.length);
      }
    }
  }
  // 旧装裱人设前缀（含在默认提示词基础上改过内容的版本）平滑升级为杂志社编辑人设
  const LEGACY_COMPOSE_PERSONA = "你是一位电子相框的装裱与题字设计师。";
  const NEW_COMPOSE_PERSONA = "你是某照片杂志社的装裱编辑，具有很强的审美能力与美术功底。";
  if (
    composeStored &&
    typeof composeStored.prompt === "string" &&
    composeStored.prompt.startsWith(LEGACY_COMPOSE_PERSONA)
  ) {
    composeStored.prompt = NEW_COMPOSE_PERSONA + composeStored.prompt.slice(LEGACY_COMPOSE_PERSONA.length);
  }
  // 以前运行时才追加的输出格式/overlay 说明，从此固化进保存的提示词（界面可见、可编辑），
  // 迁移后写回数据库，运行时不再偷偷拼接
  let promptMigrated = false;
  if (auditStored && typeof auditStored.prompt === "string" && !auditStored.prompt.includes("dupOf")) {
    auditStored.prompt = `${auditStored.prompt}\n\n${AUDIT_OUTPUT_HINT}`;
    promptMigrated = true;
  }
  if (
    composeStored &&
    typeof composeStored.prompt === "string" &&
    !composeStored.prompt.includes("overlay")
  ) {
    composeStored.prompt = `${composeStored.prompt}\n\n${COMPOSE_OVERLAY_HINT}`;
    promptMigrated = true;
  }
  const parsed = settingsSchema.safeParse(merged);
  if (!parsed.success) {
    console.warn("[config] 设置校验失败，使用默认配置:", parsed.error.message);
    cache = settingsSchema.parse({});
  } else {
    cache = parsed.data;
    if (promptMigrated && row) {
      const persist = { ...stored } as Record<string, unknown>;
      persist.audit = { ...(stored.audit as object), prompt: cache.audit.prompt };
      persist.compose = { ...(stored.compose as object), prompt: cache.compose.prompt };
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(JSON.stringify(persist));
      console.log("[config] 提示词已迁移：输出格式与 overlay 说明已写入保存的提示词");
    }
  }
  return cache;
}

export function updateSettings(patch: SettingsPatch): Settings {
  const current = getSettings();
  const next = deepMerge(current as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  const parsed = settingsSchema.parse(next);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(JSON.stringify(parsed));
  cache = parsed;
  onSettingsChanged?.(parsed);
  return parsed;
}

export let onSettingsChanged: ((s: Settings) => void) | null = null;
export function setSettingsChangeHandler(fn: (s: Settings) => void): void {
  onSettingsChanged = fn;
}

/** API key 脱敏：只保留后 4 位 */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "****";
  return "****" + key.slice(-4);
}

/** 返回给前端的设置（API key 脱敏） */
export function publicSettings(s: Settings = getSettings()): Record<string, unknown> {
  return {
    ...s,
    immichApiKey: maskKey(s.immichApiKey),
    audit: { ...s.audit, apiKey: maskKey(s.audit.apiKey) },
    compose: { ...s.compose, apiKey: maskKey(s.compose.apiKey) },
  };
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export { deepMerge };
