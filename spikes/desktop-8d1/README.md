# Проба 8D.1: установленный desktop-runtime

Изолированная техническая проба по этапу 8D.1 [roadmap](../../context/architecture/08-дорожная-карта/roadmap.md). Это не PMA: приложение не открывает Pinterest, не вызывает AI и не трогает `.local/pma`. Данные пишутся только в `%LOCALAPPDATA%\PMA-проба 8D1`.

## Состав

- `main.mjs` — Electron main: single-instance lock, окно `app://pma` (sandbox, contextIsolation, без nodeIntegration, запрет навигации/окон/разрешений), запуск worker через `utilityProcess` + `MessagePort`, выход по крестику с остановкой worker (предел 15 с).
- `worker.mjs` — backend utilityProcess: версии runtime, относительный ESM-импорт из ASAR, `node:sqlite` (WAL, транзакция, закрытие и повторное чтение, integrity_check), файлы по пути с пробелами и кириллицей, Playwright-core 1.64.1 → установленный Chrome (`channel:'chrome'`, headless, отдельный профиль, только локальная страница).
- Отчёт каждого запуска: `%LOCALAPPDATA%\PMA-проба 8D1\diagnostics\probe-*.json`; копии — в `evidence/`.

## Команды

```bash
npm install
npm start
npm run dist
```

`npm start` — запуск из исходников с выходом после пробы. `npm run dist` — NSIS-установщик в `dist/`. Тихая установка: `"PMA Проба 8D1 Setup 0.0.1.exe" /S`, в свою папку — `/S /D=<путь>`.

## Результат 2026-11-09 (ПК разработчика)

Windows 10 Pro 19045 x64, учётная запись без повышенных прав. Electron 45.2.3 (Node 24.22.2), electron-builder 26.18.0, Chrome 157.0.8103.38.

- Установщик per-user (123 МБ, без подписи) поставил программу без UAC; повторно — в `%LOCALAPPDATA%\Programs\PMA Проба с пробелом`.
- Установленная программа, запущенная без Node/npm/Codex в PATH и с чужим cwd, дважды прошла все 5 проверок, код выхода 0. Worker работает из `PMA-Probe-8D1.exe` и `resources/app.asar`; playwright-core работает из ASAR без распаковки.
- SQLite перечитывается между запусками: счётчик 1 (исходники) → 2 → 3 (установка), в том числе после удаления и повторной установки. Удаление сохраняет данные.
- Файлы в папке установки до и после запусков совпадают по SHA-256: программа туда не пишет.
- Второй запуск завершается сразу, worker остаётся один. Закрытие окна завершает всё за 0.1 с; процессов пробы, включая Chrome, не остаётся.

## Не проверено

- Чистый ПК без Node/npm/developer-runtime: Windows Sandbox недоступна; проверено только удалением Node из PATH на ПК разработчика.
- ПК архитектора (D0): ОС/сборка/x64, Chrome, политика сети. Установщик пробы можно запустить у неё как часть D0/D2.
- Установка per-machine в Program Files с UAC, SmartScreen для неподписанного установщика.
- Видимое окно Chrome, вход в Pinterest, прокси/корпоративная политика браузера.
- Закрытие во время активной операции Chrome/SQLite (D10) и аварийное завершение (D11).

## Значок PMA (2026-11-09)

Источник — `design/pma-desktop-icon.ico` (7 размеров, 16–256 px). Подключение: `build.win.icon` (значок вшивается в `.exe`; `signExecutable:false` отключает только подпись, а `signAndEditExecutable:false` отключил бы и значок), `nsis.installerIcon`/`uninstallerIcon`, `extraResources` → `resources/icon.ico` для `BrowserWindow.icon` в установленном пакете. `design/pma-desktop-icon.png` на Windows не нужен; понадобится для Linux/macOS-сборки или PNG-нужд UI.

Подтверждено на собранной и установленной пробе: значок PMA извлекается из `PMA-Probe-8D1.exe` и из установщика (у стандартного `electron.exe` — логотип Electron); ярлыки рабочего стола и меню «Пуск» ссылаются на `PMA-Probe-8D1.exe,0`; `resources/icon.ico` побайтно совпадает с исходником; окно отдаёт значок PMA через `WM_GETICON` (малый 24 px и большой 48 px). Отображение на панели задач глазами не проверялось.
