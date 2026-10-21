// Small workspace forms use the existing workspace styles and a separate native
// dialog. A confirmation never replaces the task/provider modal underneath it.
export function validateDialogValues(fields, values) {
  for (const field of fields) {
    const value = String(values[field.name] ?? '');
    if (field.required && !value.trim()) return { name: field.name, message: `${field.label} is required.` };
    if (field.maxLength && value.length > field.maxLength) return { name: field.name, message: `${field.label} must be ${field.maxLength} characters or fewer.` };
    if (field.options && !field.options.some(option => option.value === value)) return { name: field.name, message: `Choose a valid ${field.label.toLowerCase()}.` };
    if (field.exact !== undefined && value !== field.exact) return { name: field.name, message: 'Identifier did not match; nothing was deleted.' };
  }
  return null;
}

export function createWorkspaceDialogs(doc = document) {
  let active = null;
  let sequence = 0;
  function form({ title, message = '', fields = [], submitLabel = 'Save', destructive = false }) {
    // Ignore duplicate actions while a decision is pending; never stack unrelated
    // mutation prompts or queue a stale action after the first one completes.
    if (active) return Promise.resolve(null);
    return new Promise(resolve => {
      const previous = doc.activeElement;
      const parentDialog = previous?.closest?.('dialog[open]');
      const dialog = doc.createElement('dialog');
      dialog.className = 'workspace-modal workspace-decision';
      const prefix = `workspace-decision-${++sequence}`;
      dialog.setAttribute('aria-labelledby', `${prefix}-title`);
      const make = (tag, text, className) => {
        const element = doc.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
      };
      const heading = make('div', undefined, 'modal-heading');
      const titleElement = make('h2', title);
      titleElement.id = `${prefix}-title`;
      const close = make('button', '×', 'icon-button');
      close.type = 'button';
      close.setAttribute('aria-label', 'Cancel and close dialog');
      heading.append(titleElement, close);
      dialog.append(heading);
      if (message) {
        const copy = make('p', message, 'card-copy');
        copy.id = `${prefix}-description`;
        dialog.setAttribute('aria-describedby', copy.id);
        dialog.append(copy);
      }
      const formElement = make('form', undefined, 'manage-form');
      formElement.noValidate = true;
      const inputs = new Map();
      for (const field of fields) {
        const label = make('label');
        label.append(make('span', field.label));
        const input = make(field.options ? 'select' : field.multiline ? 'textarea' : 'input');
        input.name = field.name;
        input.id = `${prefix}-${field.name}`;
        if (field.options) for (const option of field.options) {
          const node = make('option', option.label);
          node.value = option.value;
          input.append(node);
        }
        if (field.multiline) input.rows = 4;
        if (field.maxLength) input.maxLength = field.maxLength;
        input.required = Boolean(field.required);
        input.value = field.value ?? '';
        input.setAttribute('aria-describedby', `${prefix}-error`);
        input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); error.textContent = ''; });
        label.append(input);
        inputs.set(field.name, input);
        formElement.append(label);
      }
      const error = make('p', '', 'form-note');
      error.id = `${prefix}-error`;
      error.setAttribute('role', 'alert');
      const actions = make('div', undefined, 'row-actions');
      const cancel = make('button', 'Cancel', 'secondary-button');
      cancel.type = 'button';
      const submit = make('button', submitLabel, destructive ? 'secondary-button danger-button' : 'primary-button');
      submit.type = 'submit';
      actions.append(cancel, submit);
      formElement.append(error, actions);
      dialog.append(formElement);
      let finished = false;
      const finish = value => {
        if (finished) return;
        finished = true;
        parentDialog?.removeEventListener('close', abort);
        doc.defaultView?.removeEventListener('pagehide', abort);
        if (dialog.open) dialog.close();
        dialog.remove();
        active = null;
        if (previous?.isConnected && (!parentDialog || parentDialog.open)) previous.focus();
        resolve(value);
      };
      const abort = () => finish(null);
      active = dialog;
      close.addEventListener('click', abort);
      cancel.addEventListener('click', abort);
      dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); abort(); });
      dialog.addEventListener('close', abort);
      parentDialog?.addEventListener('close', abort);
      doc.defaultView?.addEventListener('pagehide', abort);
      formElement.addEventListener('submit', event => {
        event.preventDefault();
        const values = Object.fromEntries([...inputs].map(([name, input]) => [name, input.value]));
        const invalid = validateDialogValues(fields, values);
        if (invalid) {
          error.textContent = invalid.message;
          const input = inputs.get(invalid.name);
          input.setAttribute('aria-invalid', 'true');
          input.focus();
          return;
        }
        finish(values);
      });
      doc.body.append(dialog);
      try {
        dialog.showModal();
        // Safe initial focus for destructive confirmations; normal forms focus
        // their first field. Native dialog provides focus trapping and Escape.
        (inputs.values().next().value || cancel).focus();
      } catch {
        finish(null); // Unsupported/unavailable dialog must fail closed.
      }
    });
  }
  return {
    form,
    async confirm(message, options = {}) {
      return (await form({ title: 'Confirm action', message, submitLabel: 'Confirm', ...options })) !== null;
    },
  };
}
