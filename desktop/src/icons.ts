// Icônes : glyphes Nerd Fonts (police embarquée), jamais d'emoji. Codes vérifiés dans la liste officielle (glyphnames.json).
export const I = {
  eclipse: "\u{F0594}", plus: "\uEA60", close: "\uEA76", settings: "\uEB51", send: "\uEC0F", stop: "\uEAD7",
  folder: "\uEA83", chat: "\uEA6B", trash: "\uEA81", edit: "\uEA73", search: "\uEA6D", chevron: "\uEAB4", chevronR: "\uEAB6",
  check: "\uEAB2", warn: "\uEA6C", error: "\uEA87", info: "\uEA74", shield: "\uEB53", terminal: "\uEA85", file: "\uEA7B",
  diff: "\uEAE1", export: "\uEAC2", tools: "\uEB6D", plug: "\uEB2D", key: "\uEB11", graph: "\uEB03", sidebar: "\uEBF3", copy: "\uEBCC",
  undo: "\uEAE2", pin: "\uEB2B", pinned: "\uEBA0", brain: "\u{F09D1}", clip: "\u{F03E2}", retry: "\uEB37", files: "\uEAF0", fileCode: "\uEAE9",
  history: "\uEA82", palette: "\uEB63", image: "\u{F0976}", database: "\uEACE", newFile: "\uEA7F", thinking: "\uEA61", download: "\uEAC2", lock: "\uEA75", agent: "\uEC20", web: "\uEB01", todo: "\uEAB3",
};

export const TOOL_ICON: Record<string, string> = {
  read_file: I.file, list_dir: I.folder, search_files: I.search, write_file: I.edit, edit_file: I.edit, delete_file: I.trash,
  run_command: I.terminal, todo_write: I.todo, web_fetch: I.web, ask_helper: I.agent,
};
