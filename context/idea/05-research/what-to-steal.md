# Что использовать из найденного

## Конкретные механизмы

1. **Загрузка картинки как поискового запроса.** Проверить путь Lens отдельно от создания нового пина. Источники: [Lens help](https://help.pinterest.com/en/article/pinterest-lens), [реализованный adapter search-by-image](https://github.com/dessant/search-by-image/blob/d5d20a64be2fc0fccdedbf52becb0a5f80a83848/src/utils/engines.js) (проверено 2026-11-02).
2. **Расширение от удачного пина.** Исследовать visual search/crop и related как разные стратегии; сохранять seed и происхождение кандидата. Источники: [py3-pinterest](https://github.com/bstoilov/py3-pinterest/blob/fdbe3bc64e2ec5bf0e58da01be364d81b6ce689d/py3pin/Pinterest.py), [gallery-dl](https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/pinterest.py) (проверено 2026-11-02).
3. **Сохранять исходный пин.** Для Pinterest назначения использовать Save Pin вместо публикации скачанной копии. Источник: [официальный Save Pin](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/PinsApi.md#pins_save) (проверено 2026-11-02).
4. **Собирать редактируемые объекты.** В Figma создавать картинки и текст отдельно; сохранять связь референса с созданными node ID. Источники: [Images](https://developers.figma.com/docs/plugins/working-with-images/), [Text](https://developers.figma.com/docs/plugins/working-with-text/) (проверено 2026-11-02).

## Из пользовательских примеров

Постоянный индекс, обработка небольшими этапами, продолжение после сбоя, отделение архива от групп конкретной доски и проверка реально созданных объектов. См. [вдохновение](../01-idea/inspiration.md).

Это список для оценки, не разрешение копировать произвольные части проектов без проверки лицензии и способа доступа. Стек и зависимости пока не утверждены.

См. [аналоги](analogs.md), [методологии](methodologies.md), [границы](../04-mvp/scope.md).
