import { format } from "../vendor/datefmt/index.js";

export function reportTitle(date) {
  return `Report for ${format("yyyy-mm-dd", date)}`;
}

export function fileName(date) {
  return `report-${format("yyyymmdd", date)}.txt`;
}
