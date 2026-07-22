// Minimal ambient types for the zero-dependency `qrcode-generator` package (ships no d.ts).
declare module "qrcode-generator" {
  interface QRCode {
    addData(data: string, mode?: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
    createDataURL(cellSize?: number, margin?: number): string;
  }
  function qrcode(typeNumber: number, errorCorrectionLevel: "L" | "M" | "Q" | "H"): QRCode;
  export = qrcode;
}
