import { createSelector } from 'reselect'
import { send } from 'redux-electron-ipc'
import groupBy from 'lodash/groupBy'
import config from 'config'
import { grpc } from 'workers'
import { getIntl } from '@zap/i18n'
import combinePaginators from '@zap/utils/pagination'
import { openModal, closeModal } from './modal'
import { fetchDescribeNetwork } from './network'
import { receiveTransactions, transactionsSelectors } from './transaction'
import { receivePayments, paymentSelectors } from './payment'
import { receiveInvoices, invoiceSelectors } from './invoice'
import { fetchBalance } from './balance'
import { showError, showNotification } from './notification'
import { fetchChannels } from './channels'
import createReducer from './utils/createReducer'
import messages from './messages'

// ------------------------------------
// Initial State
// ------------------------------------

// activity paginator object. must be reset for each wallet login
let paginator = null
const defaultFilter = new Set([
  'SENT_ACTIVITY',
  'RECEIVED_ACTIVITY',
  'PENDING_ACTIVITY',
  'EXPIRED_ACTIVITY',
  'INTERNAL_ACTIVITY',
])
const initialState = {
  filter: new Set([...defaultFilter]),
  filters: [
    { key: 'SENT_ACTIVITY' },
    { key: 'RECEIVED_ACTIVITY' },
    { key: 'PENDING_ACTIVITY' },
    { key: 'EXPIRED_ACTIVITY' },
    { key: 'INTERNAL_ACTIVITY' },
  ],
  modal: {
    itemType: null,
    itemId: null,
  },
  errorDialogDetails: null,
  searchText: null,
  isActivityLoading: false,
  activityLoadingError: null,
  hasNextPage: true, // whether we have next page to load. used in pagination
}

// ------------------------------------
// Constants
// ------------------------------------

export const SHOW_ACTIVITY_MODAL = 'SHOW_ACTIVITY_MODAL'
export const HIDE_ACTIVITY_MODAL = 'HIDE_ACTIVITY_MODAL'
export const CHANGE_FILTER = 'CHANGE_FILTER'
export const ADD_FILTER = 'ADD_FILTER'
export const UPDATE_SEARCH_TEXT = 'UPDATE_SEARCH_TEXT'
export const FETCH_ACTIVITY_HISTORY = 'FETCH_ACTIVITY_HISTORY'
export const FETCH_ACTIVITY_HISTORY_SUCCESS = 'FETCH_ACTIVITY_HISTORY_SUCCESS'
export const FETCH_ACTIVITY_HISTORY_FAILURE = 'FETCH_ACTIVITY_HISTORY_FAILURE'
export const OPEN_ERROR_DETAILS_DIALOG = 'OPEN_ERROR_DETAILS_DIALOG'
export const CLOSE_ERROR_DETAILS_DIALOG = 'CLOSE_ERROR_DETAILS_DIALOG'
export const SET_HAS_NEXT_PAGE = 'SET_HAS_NEXT_PAGE'

// ------------------------------------
// Helpers
// ------------------------------------

// getMonth() returns the month in 0 index (0 for Jan), so we create an arr of the
// string representation we want for the UI
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * propMatches - Check whether a prop exists and contains a given search string.
 *
 * @param  {string}  prop Prop name
 * @returns {boolean} Boolean indicating if the prop was found and contains the search string
 */
const propMatches = function propMatches(prop) {
  const { item, searchTextSelector = '' } = this
  return item[prop] && item[prop].toLowerCase().includes(searchTextSelector.toLowerCase())
}

/**
 * returnTimestamp - Returns invoice, payment or transaction timestamp.
 *
 * @param  {object} activity Activity item
 * @returns {string} Timestamp
 */
function returnTimestamp(activity) {
  switch (activity.type) {
    case 'transaction':
      return activity.time_stamp
    case 'invoice':
      return activity.settled ? activity.settle_date : activity.creation_date
    case 'payment':
      return activity.creation_date
    default:
      return null
  }
}

/**
 * saveInvoice - Initiates saving of invoice pdf.
 *
 * @param {string} options invoice options
 * @param {string} options.defaultFilename invoice title
 * @param {string} options.title invoice title
 * @param {string} options.subtitle invoice subtitle
 * @param {Array<Array>} options.invoiceData invoice rows
 * @returns {Function} Thunk
 */
export const saveInvoice = ({
  defaultFilename,
  title,
  subtitle,
  invoiceData,
}) => async dispatch => {
  dispatch(send('saveInvoice', { defaultFilename, title, subtitle, invoiceData }))
}

/**
 * saveInvoiceFailure - Invoice save failed event.
 *
 * @returns {Function} Thunk
 */
export const saveInvoiceFailure = () => dispatch => {
  dispatch(showError(getIntl().formatMessage(messages.activity_invoice_download_error)))
}

/**
 * saveInvoiceSuccess - Invoice save success event.
 *
 * @returns {Function} Thunk
 */
export const saveInvoiceSuccess = () => dispatch => {
  dispatch(showNotification(getIntl().formatMessage(messages.activity_invoice_download_success)))
}

/**
 * groupAll - Sorts data by date and inserts grouping titles.
 *
 * @param {Array} data Items to group
 * @returns {Array} Groups items
 */
export function groupActivity(data) {
  // according too https://stackoverflow.com/a/11252167/3509860
  // this provides an accurate measurement including handling of DST
  const daysBetween = (t1, t2) => Math.round((t2 - t1) / 86400)
  return data
    .sort((a, b) => b.timestamp - a.timestamp)
    .reduce((acc, next) => {
      const prev = acc[acc.length - 1]
      // check if need insert a group title
      if (prev) {
        const days = daysBetween(next.timestamp, prev.timestamp)
        if (days >= 1) {
          acc.push({ title: next.date })
        }
      } else {
        // This is a very first row. Insert title here too
        acc.push({ title: next.date })
      }
      acc.push(next)
      return acc
    }, [])
}

/**
 * applySearch - Filter activity list by checking various properties against a given search string.
 *
 * @param  {Array}  data Activity item list
 * @param  {string} searchTextSelector Search text
 * @returns {Array}  Filtered activity list
 */
const applySearch = (data, searchTextSelector) => {
  if (!searchTextSelector) {
    return data
  }

  return data.filter(item => {
    // Check basic props for a match.
    const hasPropMatch = [
      'date',
      'type',
      'memo',
      'tx_hash',
      'payment_hash',
      'payment_preimage',
      'payment_request',
      'dest_node_pubkey',
      'dest_node_alias',
    ].some(propMatches, { item, searchTextSelector })

    // Check every destination address.
    const hasAddressMatch =
      item.dest_addresses && item.dest_addresses.find(addr => addr.includes(searchTextSelector))

    // Include the item if at least one search criteria matches.
    return hasPropMatch || hasAddressMatch
  })
}

const prepareData = (data, searchText) => {
  return groupActivity(applySearch(data, searchText))
}

// ------------------------------------
// Actions
// ------------------------------------

/**
 * showErrorDetailsDialog - Show the activity error detail dialog.
 *
 * @param {object} error Error description
 * @returns {object} Action
 */
export function showErrorDetailsDialog(error) {
  return {
    type: OPEN_ERROR_DETAILS_DIALOG,
    error,
  }
}

/**
 * hideErrorDetailsDialog - Hide the activity error detail dialog.
 *
 * @returns {object} Action
 */
export function hideErrorDetailsDialog() {
  return {
    type: CLOSE_ERROR_DETAILS_DIALOG,
  }
}

/**
 * showActivityModal - Show the activity modal with a given activity item.
 *
 * @param {string} itemType Item type
 * @param {string} itemId Item id
 * @returns {Function} Thunk
 */
export const showActivityModal = (itemType, itemId) => dispatch => {
  dispatch({ type: SHOW_ACTIVITY_MODAL, itemType, itemId })
  dispatch(openModal('ACTIVITY_MODAL'))
}

/**
 * hideActivityModal - Hide the activity modal.
 *
 * @returns {Function} Thunk
 */
export const hideActivityModal = () => dispatch => {
  dispatch({ type: HIDE_ACTIVITY_MODAL })
  dispatch(closeModal('ACTIVITY_MODAL'))
}

/**
 * changeFilter - Toggle specified activity filter.
 *
 * @param {...string} filterList Filter to apply
 * @returns {object} Action
 */
export function changeFilter(...filterList) {
  return {
    type: CHANGE_FILTER,
    filterList,
  }
}
/**
 * addFilter - Enable specified activity filters.
 *
 * @param {...string} filterList Filters to apply
 * @returns {object} Action
 */
export function addFilter(...filterList) {
  return {
    type: ADD_FILTER,
    filterList,
  }
}

/**
 * updateSearchText - Set the current activity search string.
 *
 * @param {string} searchText Search string to apply
 * @returns {object} Action
 */
export function updateSearchText(searchText = null) {
  return {
    type: UPDATE_SEARCH_TEXT,
    searchText,
  }
}

/**
 * fetchActivityHistory - Fetch user activity history, including Balance, Payments, Invoices, Transactions etc.
 *
 * @returns {Function} Thunk
 */
export const fetchActivityHistory = () => dispatch => {
  dispatch({ type: FETCH_ACTIVITY_HISTORY })
  try {
    dispatch(fetchDescribeNetwork())
    dispatch(fetchChannels())
    dispatch(fetchBalance())
    dispatch(loadNextPage())
    dispatch({ type: FETCH_ACTIVITY_HISTORY_SUCCESS })
  } catch (error) {
    dispatch({ type: FETCH_ACTIVITY_HISTORY_FAILURE, error })
  }
}

export const resetActivity = () => () => {
  paginator = null
}

/**
 * createActivityPaginator - Creates activity paginator object.
 *
 * @returns {Function} Paginator
 */
function createActivityPaginator() {
  const fetchInvoices = async (pageSize, offset) => {
    const { invoices, first_index_offset } = await grpc.services.Lightning.listInvoices({
      num_max_invoices: pageSize,
      index_offset: offset,
      reversed: true,
    })
    return { items: invoices, offset: first_index_offset }
  }

  const fetchPayments = async () => {
    const { payments } = await grpc.services.Lightning.listPayments()
    return { items: payments, offset: 0 }
  }

  const fetchTransactions = async () => {
    const { transactions } = await grpc.services.Lightning.getTransactions()
    return { items: transactions, offset: 0 }
  }
  const getTimestamp = item => item.time_stamp || item.settle_date || item.creation_date
  const itemSorter = (a, b) => getTimestamp(b) - getTimestamp(a)
  return combinePaginators(itemSorter, fetchInvoices, fetchPayments, fetchTransactions)
}

/**
 * getPaginator - Returns current activity paginator object. This acts as a singleton
 * and creates paginator if it's not initialized.
 *
 * @returns {Function} Paginator
 */
function getPaginator() {
  if (!paginator) {
    paginator = createActivityPaginator()
  }
  return paginator
}

/**
 * loadNextPage - Loads next activity page if it's available.
 *
 * @returns {Function} Thunk
 */
export const loadNextPage = () => async (dispatch, getState) => {
  const paginator = getPaginator()
  if (hasNextPageSelector(getState())) {
    const { items, hasNextPage } = await paginator(config.activity.pageSize)

    const getItemType = item => {
      if (item.dest_addresses) {
        return 'transactions'
      }
      if ('add_index' in item) {
        return 'invoices'
      }
      return 'payments'
    }

    const { invoices, payments, transactions } = groupBy(items, getItemType)
    dispatch({ type: SET_HAS_NEXT_PAGE, value: hasNextPage })
    invoices && dispatch(receiveInvoices(invoices))
    payments && dispatch(receivePayments(payments))
    transactions && dispatch(receiveTransactions(transactions))
  }
}

// ------------------------------------
// Action Handlers
// ------------------------------------

const ACTION_HANDLERS = {
  [SHOW_ACTIVITY_MODAL]: (state, { itemType, itemId }) => {
    state.modal = { itemType, itemId }
  },
  [HIDE_ACTIVITY_MODAL]: state => {
    state.modal = { itemType: null, itemId: null }
  },
  [CHANGE_FILTER]: (state, { filterList }) => {
    const { filter } = state
    filterList.forEach(item => {
      if (filter.has(item)) {
        filter.delete(item)
      } else {
        filter.add(item)
      }
    })
  },
  [ADD_FILTER]: (state, { filterList }) => {
    const { filter } = state
    // No filters means all filters are active so no need to add anything
    if (filter.size > 0) {
      filterList.forEach(item => filter.add(item))
    }
  },
  [UPDATE_SEARCH_TEXT]: (state, { searchText }) => {
    state.searchText = searchText
  },
  [FETCH_ACTIVITY_HISTORY]: state => {
    state.isActivityLoading = true
  },
  [FETCH_ACTIVITY_HISTORY_SUCCESS]: state => {
    state.isActivityLoading = false
  },
  [FETCH_ACTIVITY_HISTORY_FAILURE]: (state, { error }) => {
    state.isActivityLoading = false
    state.activityLoadingError = error
  },
  [OPEN_ERROR_DETAILS_DIALOG]: (state, { error }) => {
    state.errorDialogDetails = error
  },
  [CLOSE_ERROR_DETAILS_DIALOG]: state => {
    state.errorDialogDetails = null
  },
  [SET_HAS_NEXT_PAGE]: (state, { value }) => {
    state.hasNextPage = value
  },
}

// ------------------------------------
// Selectors
// ------------------------------------

const activitySelectors = {}
const filterSelector = state => state.activity.filter
const hasNextPageSelector = state => state.activity.hasNextPage
const errorDialogDetailsSelector = state => state.activity.errorDialogDetails
const filtersSelector = state => state.activity.filters
const searchTextSelector = state => state.activity.searchText
const modalItemTypeSelector = state => state.activity.modal.itemType
const modalItemIdSelector = state => state.activity.modal.itemId
const paymentsSelector = state => paymentSelectors.payments(state)
const paymentsSendingSelector = state => paymentSelectors.paymentsSending(state)
const invoicesSelector = state => invoiceSelectors.invoices(state)
const transactionsSelector = state => transactionsSelectors.transactions(state)
const transactionsSendingSelector = state => transactionsSelectors.transactionsSending(state)

activitySelectors.filter = filterSelector
activitySelectors.filters = filtersSelector
activitySelectors.searchText = searchTextSelector

activitySelectors.activityModalItem = createSelector(
  paymentsSelector,
  invoicesSelector,
  transactionsSelector,
  modalItemTypeSelector,
  modalItemIdSelector,
  (payments, invoices, transactions, itemType, itemId) => {
    switch (itemType) {
      case 'INVOICE':
        return invoices.find(invoice => invoice.payment_request === itemId)
      case 'TRANSACTION':
        return transactions.find(transaction => transaction.tx_hash === itemId)
      case 'PAYMENT':
        return payments.find(payment => payment.payment_hash === itemId)
      default:
        return null
    }
  }
)

// decorates activity entry with date and timestamp fields
const addDate = entry => {
  const timestamp = returnTimestamp(entry)
  const d = new Date(timestamp * 1000)
  const date = d.getDate()
  return { ...entry, date: `${months[d.getMonth()]} ${date}, ${d.getFullYear()}`, timestamp }
}

// Sent activity: pre-search
const sentActivityRaw = createSelector(
  paymentsSelector,
  transactionsSelector,
  (payments, transactions) => {
    return [
      ...payments,
      ...transactions.filter(
        transaction =>
          !transaction.isReceived &&
          !transaction.isFunding &&
          !transaction.isClosing &&
          !transaction.isPending
      ),
    ].map(addDate)
  }
)

// Received activity: pre-search
const receivedActivityRaw = createSelector(
  invoicesSelector,
  transactionsSelector,
  (invoices, transactions) => {
    return [
      ...invoices.filter(invoice => invoice.settled),
      ...transactions.filter(
        transaction =>
          transaction.isReceived &&
          !transaction.isFunding &&
          !transaction.isClosing &&
          !transaction.isPending
      ),
    ].map(addDate)
  }
)

// Pending activity: pre-search
const pendingActivityRaw = createSelector(
  paymentsSendingSelector,
  transactionsSendingSelector,
  transactionsSelector,
  invoicesSelector,
  (paymentsSending, transactionsSending, transactions, invoices) => {
    return [
      ...paymentsSending,
      ...transactionsSending,
      ...transactions.filter(transaction => transaction.isPending),
      ...invoices.filter(invoice => !invoice.settled && !invoice.isExpired),
    ].map(addDate)
  }
)

// Expired activity: pre-search
const expiredActivityRaw = createSelector(
  invoicesSelector,
  invoices => {
    return invoices.filter(invoice => !invoice.settled && invoice.isExpired).map(addDate)
  }
)

// Internal activity: pre-search
const internalActivityRaw = createSelector(
  transactionsSelector,
  transactions => {
    return transactions
      .filter(
        transaction => transaction.isFunding || (transaction.isClosing && !transaction.isPending)
      )
      .map(addDate)
  }
)

activitySelectors.isErrorDialogOpen = createSelector(
  errorDialogDetailsSelector,
  error => Boolean(error)
)

activitySelectors.errorDialogDetailsSelector = errorDialogDetailsSelector

activitySelectors.currentActivity = createSelector(
  searchTextSelector,
  filterSelector,
  sentActivityRaw,
  receivedActivityRaw,
  pendingActivityRaw,
  expiredActivityRaw,
  internalActivityRaw,
  (searchText, filters, sent, received, pending, expired, internal) => {
    const result = []
    const curFilter = filters.size ? filters : defaultFilter

    curFilter.has('SENT_ACTIVITY') && result.push(...sent)
    curFilter.has('RECEIVED_ACTIVITY') && result.push(...received)
    curFilter.has('PENDING_ACTIVITY') && result.push(...pending)
    curFilter.has('EXPIRED_ACTIVITY') && result.push(...expired)
    curFilter.has('INTERNAL_ACTIVITY') && result.push(...internal)

    return prepareData(result, searchText)
  }
)

activitySelectors.isCustomFilter = createSelector(
  filterSelector,
  filters => {
    if (filters.size && filters.size !== defaultFilter.size) {
      return true
    }
    const difference = new Set([...filters].filter(x => !defaultFilter.has(x)))
    return difference.size > 0
  }
)

export { activitySelectors }

export default createReducer(initialState, ACTION_HANDLERS)
