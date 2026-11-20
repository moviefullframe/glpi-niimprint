(() => {
    'use strict';

    const model = {
        id: 528,
        name_prefixes: ['D11'],
        task: 'v4',
        dpi: 300,
        density: 3,
        label_type: 1,
        speed: 1,
    };
    const size = { w_px: 142, h_px: 260, dpi: 300, offset_y_px: -6 };
    let printing = false;
    let activeLabel;
    let toolbar;
    let tabs;

    function makeLabel(qrModules, inventoryNumber, year) {
        const grid = Math.sqrt(qrModules.length);
        const version = (grid - 17) / 4;
        if (!Number.isInteger(version) || version < 1 || version > 40 || /[^01]/.test(qrModules)) {
            throw new Error('Не удалось определить сетку QR-кода.');
        }
        const dot = Math.floor(Math.min(size.w_px, size.h_px) / (grid + 8));
        if (dot < 2) {
            throw new Error('QR-код слишком плотный для этикетки 12 × 22 мм.');
        }

        const canvas = document.createElement('canvas');
        canvas.width = size.w_px;
        canvas.height = size.h_px;
        const writer = canvas.getContext('2d');
        writer.fillStyle = '#fff';
        writer.fillRect(0, 0, canvas.width, canvas.height);
        writer.fillStyle = '#000';
        const landscapeWidth = canvas.height;
        const landscapeHeight = canvas.width;
        const lines = [
            { text: inventoryNumber, fontSize: 16, heightScale: 1.6 },
            { text: year, fontSize: 18, heightScale: 1.45 },
        ].filter(line => line.text);
        const lineHeight = 29;
        const qrArea = (grid + 8) * dot;
        const gap = lines.length ? 4 : 0;
        const maxTextWidth = landscapeWidth - qrArea - gap - 12;
        let textWidth = 0;
        for (const line of lines) {
            while (true) {
                line.font = `bold ${line.fontSize}px monospace`;
                writer.font = line.font;
                const lineWidth = Math.ceil(writer.measureText(line.text).width);
                if (lineWidth <= maxTextWidth) {
                    line.font = `bold ${line.fontSize + 1}px monospace`;
                    writer.font = line.font;
                    line.width = Math.min(maxTextWidth, Math.ceil(writer.measureText(line.text).width));
                    textWidth = Math.max(textWidth, line.width);
                    break;
                }
                if (line.fontSize <= 10) {
                    throw new Error('Инвентарный номер слишком длинный для этой этикетки.');
                }
                line.fontSize--;
            }
        }
        const contentLeft = Math.floor((landscapeWidth - qrArea - gap - textWidth) / 2);
        const labelLeft = contentLeft + 4 * dot;
        const labelTop = Math.floor((landscapeHeight - qrArea) / 2) + 4 * dot;
        writer.translate(canvas.width, 0);
        writer.rotate(Math.PI / 2);
        for (let row = 0; row < grid; row++) {
            for (let column = 0; column < grid; column++) {
                if (qrModules[row * grid + column] === '1') {
                    writer.fillRect(labelLeft + column * dot, labelTop + row * dot, dot, dot);
                }
            }
        }
        writer.textAlign = 'center';
        writer.textBaseline = 'middle';
        const textCenter = contentLeft + qrArea + gap + textWidth / 2;
        for (const [index, line] of lines.entries()) {
            writer.font = line.font;
            const baseline = landscapeHeight / 2 + (index - (lines.length - 1) / 2) * lineHeight;
            writer.save();
            writer.translate(textCenter, baseline);
            writer.scale(1, line.heightScale);
            writer.fillText(line.text, 0, 0, line.width);
            writer.restore();
        }
        return canvas.toDataURL('image/png');
    }

    function makeToolbar() {
        const container = document.createElement('div');
        container.className = 'd-flex flex-wrap align-items-center gap-2 mb-2';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline-primary btn-sm niimprint-button';
        button.textContent = 'Распечатать QR · 12 × 22 мм';
        const status = document.createElement('div');
        status.className = 'small';
        status.setAttribute('role', 'status');
        container.append(button, status);

        button.addEventListener('click', async () => {
            if (printing || !activeLabel) return;
            const { qrModules, inventoryNumber, year } = activeLabel.dataset;
            const driver = window.Niimbot;
            if (!driver?.isSupported()) {
                status.textContent = 'Откройте GLPI по HTTPS в Chrome с доступом к Bluetooth.';
                return;
            }
            printing = button.disabled = true;
            try {
                const label = makeLabel(qrModules, inventoryNumber.trim(), year);
                status.textContent = 'Подключение к принтеру…';
                await driver.identify(model);
                if (driver.printer?.modelId !== model.id) {
                    await driver.disconnect();
                    throw new Error('Выберите принтер NIIMBOT D11_H.');
                }
                status.textContent = 'Печать…';
                await driver.printImage(label, { model, size, strictAcknowledgements: true });
                status.textContent = 'Принтер подтвердил печать.';
            } catch (error) {
                const stage = {
                    0x21: 'настройка плотности',
                    0x23: 'установка типа этикетки',
                    0x01: 'начало печати',
                    0x13: 'установка размера',
                    0xe3: 'завершение страницы',
                    0xf3: 'завершение задания',
                }[error.niimbotCommand];
                if (error.niimbotCode === 0x02) {
                    status.textContent = 'Принтер не обнаружил бумагу (DB 02). Проверьте установку рулона.';
                } else if (error.niimbotCode === 0x08) {
                    status.textContent = 'Сбой подачи этикетки (DB 08). Переустановите рулон и оставьте примерно 5 мм ленты снаружи.';
                } else if (stage && error.niimbotCode != null) {
                    const code = error.niimbotCode.toString(16).padStart(2, '0').toUpperCase();
                    status.textContent = `Принтер отклонил команду: ${stage} (DB ${code}). Проверьте этикетку перед повтором.`;
                } else if (stage) {
                    status.textContent = `Нет ответа принтера: ${stage}. Проверьте этикетку перед повтором.`;
                } else {
                    status.textContent = error.message;
                }
            } finally {
                printing = button.disabled = false;
            }
        });
        return container;
    }

    function scan() {
        const currentTabs = document.querySelector('main #tabspanel')?.closest('.card-tabs');
        if (tabs !== currentTabs) {
            toolbar?.remove();
            toolbar = undefined;
            activeLabel = undefined;
            tabs = currentTabs;
        }

        const id = new URLSearchParams(window.location.search).get('id') ?? '';
        if (!tabs || !/^[1-9][0-9]*$/.test(id)) return;

        const activePane = tabs.querySelector('[data-glpi-tab-content].active');
        const label = activePane?.querySelector(`[data-niimprint-item="${id}"][data-qr-modules]`);
        if (label) activeLabel = label;
        if (!activeLabel) return;
        toolbar ??= makeToolbar();
        const qrField = activePane?.querySelector('[data-testid="form-field-qrcode"]');
        if (qrField?.querySelector('img')) {
            if (toolbar.parentElement !== qrField) {
                toolbar.classList.add('mt-2');
                qrField.append(toolbar);
            }
        } else if (tabs.previousElementSibling !== toolbar) {
            toolbar.classList.remove('mt-2');
            tabs.before(toolbar);
        }
    }

    function start() {
        scan();
        new MutationObserver(scan).observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
