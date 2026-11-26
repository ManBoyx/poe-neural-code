// Icônes : glyphes Nerd Fonts (police JetBrainsMono NF embarquée), jamais d'emoji.
// Chaque code a été vérifié par son NOM dans la police elle-même (table des glyphes, « md-… »).
export const I = {
  eclipse: "\u{F0594}", // md-weather_night
  chat: "\u{F0EDE}", // md-chat_outline
  work: "\u{F0174}", // md-code_tags
  media: "\u{F02F9}", // md-image_multiple
  plus: "\u{F0415}",
  search: "\u{F0349}",
  send: "\u{F005D}", // md-arrow_up
  stop: "\u{F04DB}",
  mic: "\u{F036C}",
  micOff: "\u{F036D}",
  phone: "\u{F03F2}",
  hangup: "\u{F03F5}",
  wave: "\u{F147D}", // md-waveform
  image: "\u{F02E9}",
  video: "\u{F0567}",
  music: "\u{F0387}", // md-music_note
  chart: "\u{F0128}", // md-chart_bar
  folder: "\u{F024B}",
  folderPlus: "\u{F0257}",
  key: "\u{F0306}",
  shield: "\u{F0498}",
  lock: "\u{F033E}",
  server: "\u{F048B}",
  history: "\u{F02DA}",
  close: "\u{F0156}",
  check: "\u{F012C}",
  alert: "\u{F0026}",
  cog: "\u{F0493}",
  tune: "\u{F062E}",
  rail: "\u{F10AB}", // md-dock_right
  menu: "\u{F035C}",
  chevron: "\u{F0140}", // md-chevron_down
  robot: "\u{F06A9}",
  agents: "\u{F000E}", // md-account_multiple
  bolt: "\u{F140B}", // md-lightning_bolt
  tool: "\u{F05B7}", // md-wrench
  file: "\u{F09EE}",
  console: "\u{F018D}",
  brain: "\u{F09D1}",
  pencil: "\u{F03EB}",
  copy: "\u{F018F}",
  download: "\u{F01DA}",
  refresh: "\u{F0450}",
  sun: "\u{F05A8}",
  moon: "\u{F0594}",
  speed: "\u{F04C5}", // md-speedometer
  sparkle: "\u{F0674}", // md-creation
  dots: "\u{F01D8}",
  volume: "\u{F057E}",
};

export const TOOL_ICON: Record<string, string> = {
  read_file: I.file, list_dir: I.folder, search_files: I.search, write_file: I.pencil, edit_file: I.pencil,
  run_command: I.console, todo_write: I.check, web_fetch: I.search, skill: I.sparkle,
  Bash: I.console, Read: I.file, Write: I.pencil, Edit: I.pencil, Grep: I.search, Glob: I.search, Agent: I.robot, Task: I.robot,
};
