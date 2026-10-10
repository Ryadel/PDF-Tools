type Child = Node | string | null | undefined | false;

interface Props {
  class?: string;
  title?: string;
  text?: string;
  attrs?: Record<string, string | boolean | undefined>;
  dataset?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

/** Creates an element: `h("button", { class: "icon", on: { click } }, icon("zoom-in"))`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) {
    element.className = props.class;
  }
  if (props.title) {
    element.title = props.title;
  }
  if (props.text !== undefined) {
    element.textContent = props.text;
  }
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === true) {
      element.setAttribute(name, "");
    } else if (value !== false && value !== undefined) {
      element.setAttribute(name, value);
    }
  }
  Object.assign(element.dataset, props.dataset ?? {});
  for (const [name, listener] of Object.entries(props.on ?? {})) {
    element.addEventListener(name, listener as EventListener);
  }
  append(element, ...children);
  return element;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child) {
      parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
  }
}

/** True when keyboard input should go to the focused control, not to shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
