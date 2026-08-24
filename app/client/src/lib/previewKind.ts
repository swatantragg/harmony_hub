
export type PreviewKind =
  | 'image' | 'audio' | 'video' | 'pdf'
  | 'text' | 'table' | 'sheet' | 'word' | 'slides'
  | 'archive' | 'binary';

const BY_EXT: Record<string, PreviewKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  avif: 'image', bmp: 'image', ico: 'image', heic: 'image', tif: 'image', tiff: 'image',

  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', m4a: 'audio', ogg: 'audio',
  oga: 'audio', opus: 'audio', aiff: 'audio', aif: 'audio', wma: 'audio',

  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video',
  mpg: 'video', mpeg: 'video', wmv: 'video',

  pdf: 'pdf',

  txt: 'text', md: 'text', markdown: 'text', json: 'text', xml: 'text', yml: 'text',
  yaml: 'text', log: 'text', srt: 'text', vtt: 'text', ini: 'text', html: 'text',
  css: 'text', js: 'text', ts: 'text', rtf: 'text',

  csv: 'table', tsv: 'table',

  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', ods: 'sheet',
  docx: 'word', doc: 'word', odt: 'word',
  pptx: 'slides', ppt: 'slides', odp: 'slides',

  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
};

const BY_MIME: [RegExp, PreviewKind][] = [
  [/^image\//, 'image'],
  [/^audio\//, 'audio'],
  [/^video\//, 'video'],
  [/^application\/pdf$/, 'pdf'],
  [/spreadsheetml|ms-excel|opendocument\.spreadsheet/, 'sheet'],
  [/wordprocessingml|msword|opendocument\.text/, 'word'],
  [/presentationml|ms-powerpoint|opendocument\.presentation/, 'slides'],
  [/^text\/csv$|tab-separated/, 'table'],
  [/^text\//, 'text'],
  [/^application\/(json|xml|javascript)$/, 'text'],
  [/zip|x-tar|gzip|x-7z/, 'archive'],
];

export const extensionOf = (name: string) => (name.split('.').pop() ?? '').toLowerCase();

export function previewKind(mimeType: string | null | undefined, name = ''): PreviewKind {
  const ext = extensionOf(name);
  if (BY_EXT[ext] && ['sheet', 'word', 'slides', 'table'].includes(BY_EXT[ext])) return BY_EXT[ext];
  for (const [pattern, kind] of BY_MIME) if (pattern.test(mimeType ?? '')) return kind;
  return BY_EXT[ext] ?? 'binary';
}

export const isOoxml = (name: string) => ['xlsx', 'xlsm', 'docx', 'pptx'].includes(extensionOf(name));

export const KIND_LABEL: Record<PreviewKind, string> = {
  image: 'Image', audio: 'Audio', video: 'Video', pdf: 'PDF',
  text: 'Text', table: 'Table', sheet: 'Spreadsheet', word: 'Document',
  slides: 'Slides', archive: 'Archive', binary: 'File',
};
