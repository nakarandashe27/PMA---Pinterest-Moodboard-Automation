# Источники и границы проверки

Дата обращения ко всем источникам ниже: **2026-11-02**. В исходном исследовательском проходе первичные материалы читались без входа, интеграционных операций и медиа. Последующие реальные наблюдения вынесены в [протокол G1](../../architecture/06-решения/протокол-g1-2026-11-02.md).

## Pinterest

- [Lens](https://help.pinterest.com/en/article/pinterest-lens): внешний визуальный вход в UI.
- [Visual search](https://help.pinterest.com/en/article/use-visual-search-features): пин, объект, crop и похожие результаты.
- [Discover ideas](https://help.pinterest.com/en/article/discover-ideas-on-pinterest), [Boards](https://help.pinterest.com/en-gb/article/boards): related ideas и рекомендации досок; не контракт серверного API.
- [OpenAPI v5](https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml), [Search API](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/SearchApi.md): поиск пользовательских пинов и ограниченный beta partner search. В просмотренном контракте публичный Lens endpoint не найден.
- [Save Pin](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/PinsApi.md#pins_save): сохранение публичного пина по ID в свою доску/секцию без перепубликации.
- [OAuth и scopes](https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/): Authorization Code для независимых пользователей; отдельные права на secret-данные.
- [User account](https://developers.pinterest.com/docs/api/v5/user_account-get/): проверка ID и username активного аккаунта.
- [Access tiers](https://dev.pinterest.com/docs/key-concepts/access-tiers/): Trial/Sandbox и Standard review; не гарантия широкого поиска.
- [Terms](https://policy.pinterest.com/en/terms-of-service), [Developer guidelines](https://policy.pinterest.com/en/developer-guidelines): ограничения сбора и осознанность пользовательских действий. Пример `choose each Pin` в guidelines относится к scheduled publishing; требование отдельного клика для каждого пина при bulk save не установлено. Конкретный UX группового сохранения требует проверки.

На странице Terms анонсировано обновление с 2026-11-12; перед реализацией перечитать действующую редакцию. Неподтверждённые даты ограничений для non-business аккаунтов не включены как факты.

## Figma

- [Сравнение API](https://developers.figma.com/compare-apis/): REST и Plugin API имеют разное назначение.
- [Plugin overview](https://developers.figma.com/docs/plugins/): запуск пользователем, не постоянный фоновой плагин.
- [Images](https://developers.figma.com/docs/plugins/working-with-images/), [createImage](https://developers.figma.com/docs/plugins/api/properties/figma-createimage/): байты изображения и отдельные image fills.
- [Text](https://developers.figma.com/docs/plugins/working-with-text/), [HyperlinkTarget](https://developers.figma.com/docs/plugins/api/HyperlinkTarget/): отдельные подписи и URL-ссылки.
- [Manifest](https://developers.figma.com/docs/plugins/manifest/), [Network requests](https://developers.figma.com/docs/plugins/making-network-requests/): networkAccess, локальные адреса и сетевые ограничения. Связка в установленном клиенте не проверялась.

## Открытый код

Конкретные исходники и ограничения перечислены в [аналогах](analogs.md). Предпочитать закреплённые commit URLs для воспроизводимости. История issues описывает сообщения пользователей и не является тестом текущей работоспособности.

## Ограничения исследования

Нет тестов аккаунта, Lens, OAuth, secret scopes, скачивания или импорта 25 изображений. Не подтверждены права на конкретные изображения и статус реализации показанных проектов. Нет измерений качества, скорости или расходов. Провайдер AI не выбран.

См. [выводы](README.md), [методологии](methodologies.md), [состав первой версии](../04-mvp/scope.md).

См. [матрицу механизмов поиска](search-matrix.md).
