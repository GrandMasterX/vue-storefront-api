import getFunctionScores from './elasticsearch/score'
import getMultiMatchConfig from './elasticsearch/multimatch'
import getBoosts from './elasticsearch/boost'
import getMapping from './elasticsearch/mapping'
import cloneDeep from 'lodash/cloneDeep'
import config from 'config'
import bodybuilder from 'bodybuilder'

const prepareElasticsearchQueryBody = (searchQuery) => {
  const optionsPrefix = '_options'
  const queryText = searchQuery.getSearchText()
  const rangeOperators = ['gt', 'lt', 'gte', 'lte', 'moreq', 'from', 'to']
  let query = bodybuilder()

  // process applied filters
  const appliedFilters = cloneDeep(searchQuery.getAppliedFilters()) // copy as function below modifies the object
  if (appliedFilters.length > 0) {
    let hasCatalogFilters = false

    // apply default filters
    appliedFilters.forEach(filter => {
      if (filter.scope === 'default') {
        if (Object.keys(filter.value).every(v => rangeOperators.includes(v))) {
          // process range filters
          query = query.filter('range', filter.attribute, filter.value)
        } else {
          // process terms filters
          filter.value = filter.value[Object.keys(filter.value)[0]]
          if (!Array.isArray(filter.value)) {
            filter.value = [filter.value]
          }
          query = query.filter('terms', getMapping(filter.attribute), filter.value)
        }
      } else if (filter.scope === 'catalog') {
        hasCatalogFilters = true
      }
    })

    // apply catalog scope filters
    let attrFilterBuilder = (filterQr, attrPostfix = '') => {
      appliedFilters.forEach(catalogfilter => {
        const valueKeys = Object.keys(catalogfilter.value)
        if (catalogfilter.scope === 'catalog' && valueKeys.length) {
          const isRange = valueKeys.filter(value => rangeOperators.indexOf(value) !== -1)
          if (isRange.length) {
            let rangeAttribute = catalogfilter.attribute
            // filter by product fiunal price
            if (rangeAttribute === 'price') {
              rangeAttribute = 'final_price'
            }
            // process range filters
            filterQr = filterQr.andFilter('range', rangeAttribute, catalogfilter.value)
          } else {
            // process terms filters
            let newValue = catalogfilter.value[Object.keys(catalogfilter.value)[0]]
            if (!Array.isArray(newValue)) {
              newValue = [newValue]
            }
            if (attrPostfix === '') {
              filterQr = filterQr.andFilter('terms', getMapping(catalogfilter.attribute), newValue)
            } else {
              filterQr = filterQr.andFilter('terms', catalogfilter.attribute + attrPostfix, newValue)
            }
          }
        }
      })
      return filterQr
    }

    if (hasCatalogFilters) {
      query = query.filterMinimumShouldMatch(1).orFilter('bool', attrFilterBuilder)
        .orFilter('bool', (b) => attrFilterBuilder(b, optionsPrefix).filter('match', 'type_id', 'configurable')) // the queries can vary based on the product type
    }
  }

  // Add aggregations for catalog filters
  const allFilters = searchQuery.getAvailableFilters()
  if (allFilters.length > 0) {
    for (let attrToFilter of allFilters) {
      if (attrToFilter.scope === 'catalog') {
        if (attrToFilter.field !== 'price') {
          let aggregationSize = { size: config.get('products.filterAggregationSize')[attrToFilter.field] || config.get('products.filterAggregationSize.default') }
          query = query.aggregation('terms', getMapping(attrToFilter.field), aggregationSize)
          query = query.aggregation('terms', attrToFilter.field + optionsPrefix, aggregationSize)
        } else {
          query = query.aggregation('terms', attrToFilter.field)
          query.aggregation('range', 'price', config.get('products.priceFilters'))
        }
      }
    }
  }
  // Get searchable fields based on user-defined config.
  let getQueryBody = function (b) {
    let searchableAttributes = config.get('elasticsearch.searchableAttributes') ? config.get('elasticsearch.searchableAttributes') : {'name': {'boost': 1}}
    let searchableFields = [
    ]
    for (const attribute of Object.keys(searchableAttributes)) {
      searchableFields.push(attribute + '^' + getBoosts(attribute))
    }
    return b.orQuery('multi_match', 'fields', searchableFields, getMultiMatchConfig(queryText))
      .orQuery('bool', b => b.orQuery('terms', 'configurable_children.sku', queryText.split('-'))
        .orQuery('match_phrase', 'sku', { query: queryText, boost: 1 })
        .orQuery('match_phrase', 'configurable_children.sku', { query: queryText, boost: 1 })
      )
  }
  if (queryText !== '') {
    let functionScore = getFunctionScores()
    // Build bool or function_scrre accordingly
    if (functionScore) {
      query = query.query('function_score', functionScore, getQueryBody)
    } else {
      query = query.query('bool', getQueryBody)
    }
  }
  const queryBody: any = query.build()
  if (searchQuery.suggest) {
    queryBody.suggest = searchQuery.suggest
  }

  return queryBody
}

export default prepareElasticsearchQueryBody