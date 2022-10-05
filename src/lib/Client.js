'use strict'

const assert = require('assert')
const merge = require('merge')
const axios = require('axios')
const FormData = require('form-data')
const XMLUtils = require('./XMLUtils')
const axiosCookieJarSupport = require('axios-cookiejar-support').default
const tough = require('tough-cookie')

axiosCookieJarSupport(axios)

const xmlHeader =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<xmlszamla xmlns="http://www.szamlazz.hu/xmlszamla" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  'xsi:schemaLocation="http://www.szamlazz.hu/xmlszamla xmlszamla.xsd">\n'

const xmlFooter = '</xmlszamla>'

const szamlazzURL = 'https://www.szamlazz.hu/szamla/'

const defaultOptions = {
  eInvoice: false,
  requestInvoiceDownload: false,
  downloadedInvoiceCount: 1,
  responseVersion: 1
}

class Client {
  constructor (options) {
    this._options = merge({}, defaultOptions, options || {})

    this.useToken = typeof this._options.authToken === 'string' && this._options.authToken.trim().length > 1

    if (!this.useToken) {
      assert(typeof this._options.user === 'string' && this._options.user.trim().length > 1,
      'Valid User field missing form client options')

      assert(typeof this._options.password === 'string' && this._options.password.trim().length > 1,
      'Valid Password field missing form client options')
    }

    this._cookieJar = new tough.CookieJar()
  }

  async getInvoiceData (options) {
    const hasInvoiceId = typeof options.invoiceId === 'string' && options.invoiceId.trim().length > 1
    const hasOrderNumber = typeof options.orderNumber === 'string' && options.orderNumber.trim().length > 1
    assert(hasInvoiceId || hasOrderNumber, 'Either invoiceId or orderNumber must be specified')

    const parsedBody = await this._sendRequest(
      'action-szamla_agent_xml',
      this._generateInvoiceDataXML(options)
    )

    return parsedBody.szamla
  }

  async reverseInvoice (options) {
    assert(typeof options.invoiceId === 'string' && options.invoiceId.trim().length > 1, 'invoiceId must be specified')
    assert(options.eInvoice !== undefined, 'eInvoice must be specified')
    assert(options.requestInvoiceDownload !== undefined, 'requestInvoiceDownload must be specified')

    const httpResponse = await this._sendRequest(
      'action-szamla_agent_st',
      this._generateReverseInvoiceXML(options),
      true
    )

    let data = {
      invoiceId: httpResponse.headers.szlahu_szamlaszam,
      netTotal: httpResponse.headers.szlahu_nettovegosszeg,
      grossTotal: httpResponse.headers.szlahu_bruttovegosszeg
    }

    if (options.requestInvoiceDownload) {
      data.pdf = httpResponse.data
    }

    return data
  }

  async issueInvoice (invoice) {
    const httpResponse = await this._sendRequest(
      'action-xmlagentxmlfile',
      this._generateInvoiceXML(invoice),
      this._options.requestInvoiceDownload && this._options.responseVersion === 1
    )

    const data = {
      invoiceId: httpResponse.headers.szlahu_szamlaszam,
      netTotal: httpResponse.headers.szlahu_nettovegosszeg,
      grossTotal: httpResponse.headers.szlahu_bruttovegosszeg,
    }

    if (this._options.requestInvoiceDownload) {
      if (this._options.responseVersion === 1) {
        data.pdf = new Buffer(httpResponse.data)
      } else if (this._options.responseVersion === 2) {
        const parsed = await XMLUtils.xml2obj(httpResponse.data, { 'xmlszamlavalasz.pdf': 'pdf' })
        data.pdf = new Buffer(parsed.pdf, 'base64')
      }
    }
    return data
  }

  setRequestInvoiceDownload (value) {
    this._options.requestInvoiceDownload = value
  }

  _getAuthFields () {
    let authFields = []

    if (this.useToken) {
      authFields = authFields.concat([
        [ 'szamlaagentkulcs', this._options.authToken ],
      ])
    } else {
      authFields = authFields.concat([
        [ 'felhasznalo', this._options.user ],
        [ 'jelszo', this._options.password ],
      ])
    }

    return authFields
  }

  _generateInvoiceXML (invoice) {
    return xmlHeader +
      XMLUtils.wrapWithElement('beallitasok', [
        ...this._getAuthFields(),
        [ 'eszamla', this._options.eInvoice ],
        [ 'kulcstartojelszo', this._options.passphrase ],
        [ 'szamlaLetoltes', this._options.requestInvoiceDownload ],
        [ 'szamlaLetoltesPld', this._options.downloadedInvoiceCount ],
        [ 'valaszVerzio', this._options.responseVersion ]
      ], 1) +
      invoice._generateXML(1) +
      xmlFooter
  }

  _generateReverseInvoiceXML(options) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n\
      <xmlszamlast xmlns="http://www.szamlazz.hu/xmlszamlast" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.szamlazz.hu/xmlszamlast https://www.szamlazz.hu/szamla/docs/xsds/agentst/xmlszamlast.xsd">\n' +
      XMLUtils.wrapWithElement(
        'beallitasok', [
          ...this._getAuthFields(),
          ['eszamla', String(options.eInvoice)],
          ['szamlaLetoltes', String(options.requestInvoiceDownload)],
        ]) +
      XMLUtils.wrapWithElement(
        'fejlec', [
          ['szamlaszam', options.invoiceId],
          ['keltDatum', new Date()],
        ]) +
      '</xmlszamlast>'
  }

  _generateInvoiceDataXML(options) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n\
      <xmlszamlaxml xmlns="http://www.szamlazz.hu/xmlszamlaxml" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.szamlazz.hu/xmlszamlaxml http://www.szamlazz.hu/docs/xsds/agentpdf/xmlszamlaxml.xsd">\n' +
      XMLUtils.wrapWithElement([
        ...this._getAuthFields(),
        ['szamlaszam', options.invoiceId],
        ['rendelesSzam', options.orderNumber],
        ['pdf', options.pdf]
      ]) +
      '</xmlszamlaxml>'
  }

  async _sendRequest (fileFieldName, data, isBinaryDownload) {
    const formData = new FormData()
    formData.append(fileFieldName, data, 'request.xml')

    const axiosOptions = {
      headers: {
        ...formData.getHeaders()
      },
      jar: this._cookieJar,
    }

    if (isBinaryDownload) {
      axiosOptions.responseType = 'arraybuffer'
      axiosOptions.reponseEncoding = 'binary'
    }

    const httpResponse = await axios.post(szamlazzURL, formData.getBuffer(), axiosOptions)
    if (httpResponse.status !== 200) {
      throw new Error(`${httpResponse.status} ${httpResponse.statusText}`)
    }

    if (httpResponse.headers.szlahu_error_code) {
      const err = new Error(decodeURIComponent(httpResponse.headers.szlahu_error.replace(/\+/g, ' ')))
      err.code = httpResponse.headers.szlahu_error_code
      throw err
    }

    if (isBinaryDownload) {
      return httpResponse
    }

    const parsedBody = await XMLUtils.parseString(httpResponse.data)

    if (parsedBody.xmlszamlavalasz && parsedBody.xmlszamlavalasz.hibakod) {
      const error = new Error(parsedBody.xmlszamlavalasz.hibauzenet)
      error.code = parsedBody.xmlszamlavalasz.hibakod[0]
      throw error
    }

    return httpResponse
  }
}

module.exports = Client
