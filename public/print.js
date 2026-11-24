import { printLabel } from './vendor/niimbot.js?v=0.8.0';

(() => {
    'use strict';

    const d11 = {
        name: 'D11_H',
        id: 528,
        name_prefixes: ['D11'],
        task: 'v4',
        dpi: 300,
        density: 3,
        label_type: 1,
        speed: 1,
    };
    const b21 = { ...d11, name: 'B21 Pro', id: 785, name_prefixes: ['B21', 'NIIMBOT B21'] };
    const b21Rolls = {
        '40x30': { w_px: 472, h_px: 354, dpi: 300, offset_y_px: 0 },
        '50x30': { w_px: 576, h_px: 354, dpi: 300, offset_y_px: 0 },
    };
    const sizes = {
        '12x40': { w_px: 142, h_px: 472, dpi: 300, offset_y_px: 0 },
        '12x22': { w_px: 142, h_px: 260, dpi: 300, offset_y_px: -6 },
        '15x30': { w_px: 144, h_px: 354, dpi: 300, offset_y_px: 0 },
    };
    let printing = false;
    let activeLabel;
    let toolbar;
    let tabs;

    function makeLabel(qrModules, size, lines) {
        const grid = Math.sqrt(qrModules.length);
        const version = (grid - 17) / 4;
        if (!Number.isInteger(version) || version < 1 || version > 40 || /[^01]/.test(qrModules)) {
            throw new Error('Не удалось определить сетку QR-кода.');
        }
        const landscapeWidth = Math.max(size.w_px, size.h_px);
        const landscapeHeight = Math.min(size.w_px, size.h_px);
        const rotate = size.h_px > size.w_px;
        const qrArea = !rotate && lines.length ? Math.floor(landscapeWidth / 2) : landscapeHeight;
        const paddedGrid = grid + 8;
        if (qrArea < paddedGrid * 2) {
            throw new Error('QR-код слишком плотный для этикетки выбранного размера.');
        }

        const canvas = document.createElement('canvas');
        canvas.width = size.w_px;
        canvas.height = size.h_px;
        const writer = canvas.getContext('2d');
        writer.fillStyle = '#fff';
        writer.fillRect(0, 0, canvas.width, canvas.height);
        writer.fillStyle = '#000';
        const lineHeight = Math.min(40, Math.floor((landscapeHeight - 8) / Math.max(lines.length, 1)));
        const gap = lines.length ? 2 : 0;
        const maxTextWidth = landscapeWidth - qrArea - gap - 12;
        let textWidth = 0;
        for (const line of lines) {
            line.fontSize = Math.min(line.fontSize, Math.floor(lineHeight / line.heightScale));
            while (true) {
                line.font = `bold ${line.fontSize}px monospace`;
                writer.font = line.font;
                const lineWidth = Math.ceil(writer.measureText(line.text).width);
                if (lineWidth <= maxTextWidth) {
                    line.width = lineWidth;
                    textWidth = Math.max(textWidth, line.width);
                    break;
                }
                if (line.fontSize <= 10) {
                    throw new Error('Строка текста слишком длинная. Выберите больший размер этикетки или отключите поле в настройках.');
                }
                line.fontSize--;
            }
        }
        const contentLeft = Math.floor((landscapeWidth - qrArea - gap - textWidth) / 2);
        const labelTop = Math.floor((landscapeHeight - qrArea) / 2);
        const boundaries = Array.from({ length: grid + 1 }, (_, index) => Math.round((index + 4) * qrArea / paddedGrid));
        if (rotate) {
            writer.translate(canvas.width, 0);
            writer.rotate(Math.PI / 2);
        }
        for (let row = 0; row < grid; row++) {
            for (let column = 0; column < grid; column++) {
                if (qrModules[row * grid + column] === '1') {
                    writer.fillRect(
                        contentLeft + boundaries[column],
                        labelTop + boundaries[row],
                        boundaries[column + 1] - boundaries[column],
                        boundaries[row + 1] - boundaries[row],
                    );
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

        if (!rotate) return canvas;
        writer.resetTransform();
        const bitmap = writer.getImageData(0, 0, canvas.width, canvas.height);
        let firstInkRow = canvas.height;
        let lastInkRow = -1;
        for (let row = 0; row < canvas.height; row++) {
            const rowStart = row * canvas.width * 4;
            for (let column = 0; column < canvas.width; column++) {
                if (bitmap.data[rowStart + column * 4] >= 128) continue;
                firstInkRow = Math.min(firstInkRow, row);
                lastInkRow = row;
                break;
            }
        }
        const centeredOffset = Math.round((canvas.height - 1 - firstInkRow - lastInkRow) / 2);
        const shift = Math.max(-contentLeft, Math.min(centeredOffset, canvas.height - 1 - lastInkRow));
        if (shift !== 0) {
            writer.fillStyle = '#fff';
            writer.fillRect(0, 0, canvas.width, canvas.height);
            writer.putImageData(bitmap, 0, shift);
        }
        return canvas;
    }

    function makeToolbar() {
        const container = document.createElement('div');
        container.className = 'd-flex flex-wrap align-items-center gap-2 mb-2';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline-primary btn-sm niimprint-button';
        button.textContent = 'Распечатать QR-код';
        const status = document.createElement('div');
        status.className = 'small';
        status.setAttribute('role', 'status');
        const profile = document.createElement('select');
        profile.className = 'form-select form-select-sm w-auto';
        profile.setAttribute('aria-label', 'Принтер и размер этикетки');
        profile.add(new Option('D11_H — размер из настроек', 'd11'));
        for (const roll of Object.keys(b21Rolls)) {
            profile.add(new Option(`B21 Pro — ${roll.replace('x', ' × ')} мм`, roll));
        }
        container.append(profile, button, status);

        button.addEventListener('click', async () => {
            scan();
            if (printing || !activeLabel || toolbar !== container) return;
            const selected = activeLabel;
            const { qrModules, assetName, inventoryNumber, serial, year, printError } = selected.dataset;
            const model = profile.value === 'd11' ? d11 : b21;
            const size = model === d11 ? sizes[selected.dataset.size] : b21Rolls[profile.value];
            if (printError || !size) {
                status.textContent = printError || 'Неизвестный размер этикетки.';
                return;
            }
            if (typeof navigator.bluetooth?.requestDevice !== 'function') {
                status.textContent = window.isSecureContext
                    ? 'Этот браузер не предоставляет доступ к Web Bluetooth. На Android откройте карточку прямо в приложении Chrome. На iPhone используйте браузер с поддержкой Web Bluetooth или печатайте с компьютера.'
                    : 'Браузер не считает страницу защищённой. Откройте GLPI напрямую по HTTPS и проверьте, что браузер доверяет сертификату.';
                return;
            }
            printing = profile.disabled = button.disabled = true;
            try {
                const lines = [
                    { text: assetName, fontSize: 24, heightScale: 1.45 },
                    { text: inventoryNumber, fontSize: 24, heightScale: 1.55 },
                    { text: serial, fontSize: 24, heightScale: 1.45 },
                    { text: year, fontSize: 27, heightScale: 1.45 },
                ].filter(line => line.text?.trim());
                const label = makeLabel(qrModules, size, lines);
                status.textContent = 'Подключение к принтеру…';
                await printLabel(label, model, size, () => {
                    scan();
                    if (activeLabel !== selected) {
                        throw new Error('Карточка изменилась. Выберите этикетку заново.');
                    }
                    status.textContent = 'Печать…';
                });
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
                printing = profile.disabled = button.disabled = false;
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
        const activePane = tabs?.querySelector('[data-glpi-tab-content].active');
        const page = new URL(window.location.href);
        const label = /^[1-9][0-9]*$/.test(id) && activePane
            ? Array.from(activePane.querySelectorAll(`[data-niimprint-item="${id}"][data-niimprint-url][data-qr-modules]`)).find(candidate => {
                const asset = new URL(candidate.dataset.niimprintUrl, page);
                return asset.origin === page.origin && asset.pathname === page.pathname
                    && Array.from(asset.searchParams).every(([key, value]) => page.searchParams.get(key) === value);
            })
            : undefined;
        if (label !== activeLabel || !label) {
            toolbar?.remove();
            toolbar = undefined;
            activeLabel = label;
        }
        if (!label) return;
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
