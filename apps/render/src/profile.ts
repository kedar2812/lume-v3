/*
 * LibreOffice's settings for every conversion, written into a fresh profile each time: macros never run, linked files
 * and external data are never fetched, formulas are never recalculated (a file shows the figures it was saved with),
 * and nothing is locked. The service has no network anyway (infra/docker-compose.yml, network "render"); this is the
 * second wall.
 */
const prop = (path: string, name: string, value: string | number | boolean) =>
  `<item oor:path="${path}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`;

export const REGISTRY = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
  prop("/org.openoffice.Office.Common/Security/Scripting", "MacroSecurityLevel", 3),
  prop("/org.openoffice.Office.Common/Security/Scripting", "DisableMacrosExecution", true),
  prop("/org.openoffice.Office.Common/Security/Scripting", "BlockUntrustedRefererLinks", true),
  prop("/org.openoffice.Office.Common/Misc", "UseLocking", false),
  // Links: 2 is "never update".
  prop("/org.openoffice.Office.Writer/Content/Update", "Link", 2),
  prop("/org.openoffice.Office.Calc/Content/Update", "Link", 2),
  // Recalculation on load: 1 is "never".
  prop("/org.openoffice.Office.Calc/Formula/Load", "OOXMLRecalcMode", 1),
  prop("/org.openoffice.Office.Calc/Formula/Load", "ODFRecalcMode", 1),
  "</oor:items>",
  "",
].join("\n");
