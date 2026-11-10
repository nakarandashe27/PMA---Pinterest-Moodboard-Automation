# Исследование

Проверено 2026-11-02. Основа — официальная документация Pinterest и Figma, первичные исходники OSS и ограниченный обзор аналогов. Этот исходный обзор выполнялся без действий в аккаунтах. Более поздние [практические пробы G1](../../architecture/06-решения/протокол-g1-2026-11-02.md) описаны отдельно. Чтение кода не является интеграционным тестом.

## Главное

Pinterest документирует Lens с загрузкой внешнего изображения и визуальный поиск по существующему пину/выделенному объекту. В OSS найден реальный код отправки изображения на визуальный поиск. Доступность функции на текущем устройстве и аккаунте не проверена. Поэтому ограничивать визуальный вход только преобразованием в текст преждевременно. Источники: [Lens](https://help.pinterest.com/en/article/pinterest-lens), [visual search](https://help.pinterest.com/en/article/use-visual-search-features), [search-by-image](https://github.com/dessant/search-by-image/blob/d5d20a64be2fc0fccdedbf52becb0a5f80a83848/src/utils/engines.js) (проверено 2026-11-02).

В просмотренном официальном API публичный контракт Lens не найден. Поиск пользовательских пинов и ограниченный partner search не равнозначны Lens. Сохранение существующего публичного пина в собственную доску документировано отдельно. Источники: [Search API](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/SearchApi.md), [Save Pin](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/PinsApi.md#pins_save) (проверено 2026-11-02).

Практическая ценность проекта — ограниченный рабочий сценарий ландшафтного архитектора и продолжение работы в Figma. Рыночная уникальность и превосходство над Pinterest не установлены.

## Навигация

- [Аналоги и компоненты](analogs.md).
- [Методологии](methodologies.md).
- [Что использовать](what-to-steal.md).
- [Чего избегать](what-to-avoid.md).
- [Отличие нашей задачи](delta.md).
- [Источники и ограничения проверки](sources.md).
- [Пять направлений исследования](research-log.md): LinkedIn, соцсети, web, YC, OSS.
- [Область первой версии](../04-mvp/scope.md).

См. [матрицу механизмов поиска](search-matrix.md).
