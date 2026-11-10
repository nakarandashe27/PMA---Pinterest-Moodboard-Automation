# Аналоги и открытые компоненты

Все приведённые источники проверены 2026-11-02. Таблица описывает подтверждённые возможности исходников/документации; текущая работа с аккаунтом и качество для ландшафтных задач не проверялись. Это кандидаты для экспериментов, не выбранные зависимости.

| Кандидат | Что описано документацией или реализовано в исходнике | Ограничение и применимость |
|---|---|---|
| [Pinterest Lens](https://help.pinterest.com/en/article/pinterest-lens) | Веб-инструкция описывает загрузку внешнего изображения; мобильная — камеру/галерею | Наличие функции у конкретного аккаунта и программный доступ нужно проверить |
| [dessant/search-by-image](https://github.com/dessant/search-by-image/blob/d5d20a64be2fc0fccdedbf52becb0a5f80a83848/src/utils/engines.js) | `searchPinterest` принимает изображение и извлекает результаты со ссылками и изображениями | Реальный кодовый прецедент Lens; GPL-3.0 по [репозиторию](https://github.com/dessant/search-by-image). Недокументированный механизм, актуальная работа и полнота выдачи не доказаны |
| [py3-pinterest](https://github.com/bstoilov/py3-pinterest/blob/fdbe3bc64e2ec5bf0e58da01be364d81b6ce689d/py3pin/Pinterest.py) | Текстовый поиск; visual search от существующего pin ID/signature и crop; операции досок | Неофициальный клиент, MIT по [LICENSE](https://github.com/bstoilov/py3-pinterest/blob/master/LICENSE); произвольные байты JPG не являются входом `visual_search` |
| [gallery-dl](https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/pinterest.py) | Текстовый поиск, связанные пины, изображения и метаданные | Внутренний Pinterest web-интерфейс; [GPL v2](https://github.com/mikf/gallery-dl/blob/master/LICENSE). Активная разработка перенесена на Codeberg согласно [README](https://github.com/mikf/gallery-dl/blob/master/README.rst) |
| [Pinterest.js](https://github.com/rit3zh/Pinterest.js/blob/d4ae985dfa61a86b5fce91c2f34c372b55247d65/src/functions/visualSearch.ts) | Visual search от существующего pin ID с получением signature и области объекта | Отдельный [parser](https://github.com/rit3zh/Pinterest.js/blob/d4ae985dfa61a86b5fce91c2f34c372b55247d65/src/parser/visualSearch.ts); загрузка пользовательской картинки не подтверждена |
| [souljasec/pinterest-downloader](https://github.com/souljasec/pinterest-downloader/blob/master/pinterest_downloader.py) | Текстовый поиск, скачивание, пагинация, фильтр разрешения, дедупликация ID и SHA-256 | [MIT](https://github.com/souljasec/pinterest-downloader/blob/master/LICENSE); нет доказанного полного каталога источников, Lens, CV или Figma |
| [Официальный Pinterest SDK](https://github.com/pinterest/pinterest-python-sdk/blob/main/pinterest/organic/pins.py) | OAuth/API v5 и `Pin.save`; [создание досок](https://github.com/pinterest/pinterest-python-sdk/blob/main/pinterest/organic/boards.py) | [Apache-2.0](https://github.com/pinterest/pinterest-python-sdk/blob/main/LICENSE); широкий поиск не появляется от самого SDK |

Лицензии ещё не выбранных компонентов сверять перед включением/распространением кода; наличие OSS-лицензии не подтверждает права доступа к Pinterest или права на изображения.

## Продуктовые аналоги

| Инструмент | Подтверждённый процесс | Граница вывода |
|---|---|---|
| [Eagle Pinterest Visual Search](https://community.eagle.cool/plugin/22069a4c-58e0-44d7-89d9-69f014158acd) | Официальная карточка плагина описывает поиск от локального изображения, нескольких примеров и области | Сильный кандидат для технической проверки native visual search; запуском не проверен |
| [Milanote](https://help.milanote.com/en/articles/359381-images) | Сбор, размещение, изменение размеров и аннотации отдельных изображений | Сам по себе не подтверждает Pinterest-only поиск нашего сценария |
| [Kosmik](https://www.kosmik.app/faq/find-assets-on-the-web-with-ai) | Поиск от текста/выбранных объектов, стопка кандидатов, размещение | Заявленные функции продукта, не наш тест и не гарантия Pinterest API |
| [PureRef](https://www.pureref.com/handbook/images/) | Импорт и пространственная работа с референсами | Подтверждён сбор и раскладка, а не автоматический Pinterest discovery |

Источники проверены 2026-11-02. Цены, финансирование, рыночные доли и прямые Figma-интеграции не утверждаются. Подробности пяти направлений — в [журнале исследования](research-log.md).

## Неготовый пример Playwright

В [mcp-pinterest](https://github.com/markswendsen-code/mcp-pinterest/blob/e69effb8c007b3bfc4e051d301636b15d84c4fd0/src/index.ts) поиск читает уже загруженные карточки без полноценной пагинации и исходных pin ID; создание доски возвращает незавершённый результат, сохранение не реализует явный выбор целевой доски. Проверено 2026-11-02 по исходнику. Перечень функций README не означает готовность нашей цепочки.

См. [методологии](methodologies.md), [источники](sources.md), [что использовать](what-to-steal.md).
