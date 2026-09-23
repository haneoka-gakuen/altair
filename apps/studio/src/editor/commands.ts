export interface CommandField {
  name: string;
  label: string;
  type?: "number" | "boolean" | "color" | "text";
  choices?: readonly string[];
}
export interface EditorCommand {
  name: string;
  label: string;
  category: string;
  initial: string;
  contentLabel: string;
  fields: readonly CommandField[];
}
const duration: CommandField = {
  name: "duration",
  label: "持续时间（毫秒）",
  type: "number",
};
const next: CommandField = {
  name: "next",
  label: "执行后继续",
  type: "boolean",
};
const target: CommandField = {
  name: "target",
  label: "目标",
  choices: ["bg-main", "fig-left", "fig-center", "fig-right", "stage-main"],
};
const ease: CommandField = {
  name: "ease",
  label: "缓动",
  choices: ["linear", "easeIn", "easeOut", "easeInOut", "easeInOutSine", "easeOutCubic", "easeOutExpo"],
};
const entry = (
  name: string,
  label: string,
  category: string,
  initial: string,
  contentLabel = "内容",
  fields: readonly CommandField[] = [],
): EditorCommand => ({ name, label, category, initial, contentLabel, fields });
export const EDITOR_COMMANDS: readonly EditorCommand[] = [
  entry("say", "对话", "演出", "角色:在这里输入对话。;", "对话", [
    { name: "vocal", label: "语音" },
    { name: "volume", label: "语音音量", type: "number" },
    { name: "notend", label: "连接下一句", type: "boolean" },
    { name: "concat", label: "合并对话", type: "boolean" },
    next,
  ]),
  entry("changeBg", "背景", "演出", "changeBg:none;", "背景文件", [duration, next]),
  entry("changeFigure", "立绘", "演出", "changeFigure:none -id=character;", "立绘或模型", [
    { name: "id", label: "对象名称" },
    { name: "left", label: "左侧", type: "boolean" },
    { name: "right", label: "右侧", type: "boolean" },
    { name: "motion", label: "动作" },
    { name: "expression", label: "表情" },
    duration,
    next,
  ]),
  entry("miniAvatar", "小头像", "演出", "miniAvatar:none;", "头像文件"),
  entry("bgm", "背景音乐", "演出", "bgm:none;", "音乐文件", [
    { name: "volume", label: "音量", type: "number" },
    { name: "enter", label: "淡入（毫秒）", type: "number" },
  ]),
  entry("playEffect", "音效", "演出", "playEffect:none;", "音效文件", [
    { name: "id", label: "名称" },
    { name: "volume", label: "音量", type: "number" },
    { name: "loop", label: "循环", type: "boolean" },
    next,
  ]),
  entry("playVideo", "视频", "演出", "playVideo:;", "视频文件", [
    { name: "skipOff", label: "禁止跳过", type: "boolean" },
  ]),
  entry("intro", "独白", "演出", "intro:在这里输入文字。;", "独白文字", [
    { name: "fontSize", label: "字号", type: "number" },
    { name: "hold", label: "保留画面", type: "boolean" },
    next,
  ]),
  entry(
    "setTransform",
    "变换",
    "效果",
    'setTransform:{"position":{"x":0,"y":0},"scale":{"x":1,"y":1},"rotation":0} -target=fig-center -duration=500;',
    "变换参数",
    [target, duration, ease, next],
  ),
  entry("setAnimation", "预设动画", "效果", "setAnimation:fadeIn -target=fig-center;", "动画名称", [target, next]),
  entry("setTempAnimation", "临时动画", "效果", "setTempAnimation:[] -target=fig-center;", "关键帧", [target, next]),
  entry("setComplexAnimation", "组合动画", "效果", "setComplexAnimation:[] -target=fig-center;", "动画", [
    target,
    next,
  ]),
  entry("setFilter", "滤镜", "效果", "setFilter:0;", "滤镜", [target, duration, next]),
  entry("setTransition", "转场", "效果", "setTransition: -target=bg-main;", "转场", [target]),
  entry("pixiInit", "初始化特效", "效果", "pixiInit:;"),
  entry("pixiPerform", "粒子特效", "效果", "pixiPerform:;", "特效名称"),
  entry("filmMode", "电影模式", "显示", "filmMode:on;", "模式名称；none 或空内容关闭"),
  entry("setTextbox", "对话框", "显示", "setTextbox:show;", "显示（show / hide）"),
  entry("applyStyle", "应用样式", "显示", "applyStyle:;", "样式映射"),
  entry("label", "标签", "流程", "label:label_name;", "标签名称"),
  entry("jumpLabel", "跳转标签", "流程", "jumpLabel:label_name;", "目标标签"),
  entry("changeScene", "切换场景", "流程", "changeScene:start.txt;", "场景文件"),
  entry("callScene", "调用场景", "流程", "callScene:start.txt;", "场景文件"),
  entry("choose", "选择分支", "流程", "choose:选项一:start.txt|选项二:start.txt;", "选项与场景"),
  entry("chooseLabel", "选择标签", "流程", "chooseLabel:选项一:label_one|选项二:label_two;", "选项与标签"),
  entry("setVar", "设置变量", "流程", "setVar:score=0;", "赋值表达式", [
    { name: "global", label: "全局变量", type: "boolean" },
  ]),
  entry("if", "条件", "流程", "if:score>0;", "条件表达式"),
  entry("getUserInput", "用户输入", "流程", "getUserInput:name -title=请输入名字;", "变量", [
    { name: "title", label: "提示" },
    { name: "default", label: "默认值" },
  ]),
  entry("wait", "等待", "流程", "wait:1000;", "等待时间（毫秒）"),
  entry("end", "结束", "流程", "end;", ""),
  entry("unlockCg", "解锁鉴赏图片", "系统", "unlockCg:;", "图片文件", [{ name: "name", label: "名称" }]),
  entry("unlockBgm", "解锁音乐", "系统", "unlockBgm:;", "音乐文件", [{ name: "name", label: "名称" }]),
  entry("showVars", "显示变量", "系统", "showVars;", ""),
  entry("callSteam", "Steam", "系统", "callSteam:;", "成就"),
  entry("comment", "注释", "系统", "; 在这里写注释", "注释"),
];
export function commandDefinition(name: string, kind?: string): EditorCommand | undefined {
  return EDITOR_COMMANDS.find(
    (command) => command.name.toLowerCase() === (kind === "dialogue" ? "say" : name.toLowerCase()),
  );
}
