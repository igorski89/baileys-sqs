// Type declarations for modules without types

declare module "qrcode-terminal" {
  interface QrCodeOptions {
    small: boolean
  }
  
  function generate(qr: string, options: QrCodeOptions, callback: (qrcode: string) => void): void
  
  export { generate }
}
