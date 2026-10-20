import DOMPurify from 'dompurify';
import { mathMarkup } from './math-render';
import { markdown } from '../shared/rules';
import 'katex/dist/katex.min.css';
import './math.css';

/** Raw HTML is disabled upstream. Only KaTeX-generated markup can introduce inline styles. */
export function safeMarkdown(content: string) {
  return DOMPurify.sanitize(markdown(content, mathMarkup), {
    FORBID_TAGS: ['img', 'script', 'iframe', 'style', 'object', 'foreignObject'],
    ADD_ATTR: ['data-note'],
    ALLOW_DATA_ATTR: true,
  });
}
