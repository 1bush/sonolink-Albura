// OCR analysis of SonoLink screenshots
import Tesseract from 'tesseract.js';

const files = [
  'C:/Users/roven/Desktop/Screenshot_2026-08-17-19-48-02-408_al.albura.sonolink.jpg',
  'C:/Users/roven/Desktop/Screenshot_2026-08-17-19-48-07-425_al.albura.sonolink.jpg',
  'C:/Users/roven/Desktop/Screenshot_2026-08-17-19-48-22-873_al.albura.sonolink.jpg',
  'C:/Users/roven/Desktop/Screenshot_2026-08-17-19-48-25-837_al.albura.sonolink.jpg',
  'C:/Users/roven/Desktop/Screenshot_2026-08-17-19-48-31-578_al.albura.sonolink.jpg',
  'C:/Users/roven/Desktop/Screenshot_2026-08-17-19-48-41-171_al.albura.sonolink.jpg',
];

for (const file of files) {
  console.log(`\n=== ${file.split(/[/\\]/).pop()} ===`);
  try {
    const { data: { text } } = await Tesseract.recognize(file, 'eng', {});
    console.log(text);
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
}
