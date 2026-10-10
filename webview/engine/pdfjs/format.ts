import { language, t } from "../../l10n";

/** "D:20240115103000+01'00'" (PDF date) → localized date and time; "" if absent. */
export function describeDate(pdfDate: string): string {
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(pdfDate);
  if (!match) {
    return pdfDate;
  }
  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00", zone, zoneHour = "00", zoneMinute = "00"] = match;
  const offset = !zone || zone.toUpperCase() === "Z" ? "Z" : `${zone}${zoneHour}:${zoneMinute}`;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
  return Number.isNaN(date.getTime()) ? pdfDate : date.toLocaleString(language);
}

export function describeSize(bytes: number): string {
  if (bytes < 1024) {
    return t("{0} bytes", bytes.toLocaleString(language));
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const short = value.toLocaleString(language, { maximumFractionDigits: value < 10 ? 1 : 0 });
  return `${short} ${units[unit]} (${t("{0} bytes", bytes.toLocaleString(language))})`;
}
