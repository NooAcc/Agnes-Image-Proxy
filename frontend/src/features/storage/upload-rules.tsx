// UploadRules is the read-only upload contract shown on setup and settings.
export function UploadRules() {
  return (
    <div className="grid gap-2 rounded-[var(--component-radius)] border border-border bg-surface p-3 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">固定上传规则</p>
      <ul className="list-disc pl-5">
        <li>不压缩原图（serverCompress=false）。</li>
        <li>返回完整文件地址（returnFormat=full）。</li>
        <li>上传目录为 agnes-image-proxy/YYYY-MM-DD，日期按 UTC+8（中国标准时间）计算。</li>
      </ul>
      <p>图床应关闭文件自动过期；图床的公开链接不受本程序签名期限控制。</p>
    </div>
  );
}
