
module.exports = () => {
  const controller = {};

  /**
   * This (async) function is called before creating a new entry
   * It can be used to create default associations for the new entry
   * Assign fields to req.body to create associations or set default values for the new entry
   * 
   * Set it to null to disable this functionality
   * @param {*} req 
   * @param {*} res 
   */
  controller.createDefaultAssociations = null;

  /**
   * This (async) function is called after creating a new entry or when reading entries
   * It can be used to hide fields from the response
   * 
   * Set it to null to disable this functionality
   * @param {*} req 
   * @param {*} res 
   * 
   * @returns {Array} Array of fields to hide
   */
  controller.hiddenFields = null;

  /**
   * This (async) function is called before querying entries from the database (read, update, delete)
   * It can be used to add extra filters to the query, narrowing down the results to enforce authorization
   * 
   * Set it to null to disable this functionality
   * @param {*} req 
   * @param {*} res 
   * 
   * @returns {Object} Object containing the additional filters for the `where` clause
   */
  controller.extraFilters = null;

  /**
   * This (async) function is called before querying entries for deletion
   * It can be used to add more filters to the delete query (additional to the extraFilters)
   * 
   * Set it to null to disable this functionality
   * @param {*} req 
   * @param {*} res 
   * 
   * @returns {Object} Object containing the additional filters for the `where` clause
   */
  controller.deleteFilters = null;

  /**
   * This (async) function is called before sending the response
   * It can be used to modify the response, for example, change field names or normalize/transform data
   * 
   * Set it to null to disable this functionality
   * @param {*} req 
   * @param {*} res 
   * @param {*} queryResults
   * 
   * @returns {Object} Modified entry/enries to send in the response
   */
  controller.beforeSend = null;

  /**
   * This (async) function is called before an updating query is executed
   * It can be used to validate the query parameters
   * 
   * Set it to null to disable this functionality
   * @param {*} req 
   * @param {*} res 
   * @param {*} bodyNormalized
   * @param {*} queryFilter 
   * 
   * @returns {Boolean} True if the update should be allowed, false otherwise
   */
  controller.beforeUpdate = null;

  /**
   * This function is called after an updating query is executed
   * It can be used to perform additional operations, for example, sending a notification
   * 
   * Framework will call this function without waiting it to finish
   * To wait for the function to finish, do not define this function as async 
   * 
   * Set it to null to disable this functionality
   * @param {*} req 
   * @param {*} res 
   * @param {*} bodyNormalized 
   * @param {*} queryResults
   */
  controller.afterUpdate = null;

  /**
   * This function is called after a deleting query is executed
   * It can be used to perform additional operations, for example, sending a notification
   * 
   * Framework will call this function without waiting it to finish
   * To wait for the function to finish, do not define this function as async
   * 
   * Set it to null to disable this functionality
   * @param {*} req 
   * @param {*} res 
   * @param {*} queryFilter
   * @param {*} queryResults 
   */
  controller.afterDelete = null;

  /**
   * This (async) function is called before creating the update query
   * It can be used to set the fields read-only, for example, avoiding change associations
   * 
   * Set it to null to disable this functionality
   * @param {*} req 
   * @param {*} res 
   * 
   * @returns {Array} Array of fields to
   */
  controller.readOnlyFields = null;

  /**
   * This (async) function is called after creating an entry
   * It can be used to perform additional operations after creating, for example, sending a notification
   * 
   * @param {*} req 
   * @param {*} res 
   * @param {*} newEntry 
   */
  controller.onCreated = null;

  /**
   * This (async) function is called before creating the query to read entries
   * It can be used to set default includes for the query (associations to include in the response)
   * 
   * Set it to null to disable this functionality
   * @param {*} req 
   * @param {*} res 
   * 
   * @returns {Array} Array of Objects for the `include` option in the query
   * @returns {String} String with the model name to include
   */
  controller.defaultIncludes = null;

  /**
   * This (async) function names the association aliases a CLIENT may ask for
   * through `?include=`, for this request's user type.
   *
   * `hiddenFields` masks columns on the base model and says nothing about an
   * association, so an unvalidated include is a way around every access rule
   * on the far side of it — `customers?include=Record` handed a private file
   * to a role the private model is closed to. Anything not named here is
   * refused with a 400, and null or [] means the resource may be asked for no
   * associations at all, which is the right default.
   *
   * This is about what a client may request. `defaultIncludes` above is what
   * the server attaches on its own and needs no allow-list.
   *
   * @param {*} req
   * @param {*} res
   *
   * @returns {Array} Array of association alias strings, e.g. ['Phones']
   */
  controller.allowedIncludes = null;

  /**
   * This (async) function is called when the `search` query parameter is provided on readMany
   * It returns the columns the search term is matched against (case-insensitive substring;
   * every whitespace-separated term must match at least one column)
   * Own columns as 'column_name', to-one association columns as '$Alias.column$'
   * (the association is LEFT JOINed automatically)
   * IMPORTANT: only to-one associations (belongsTo/hasOne) are allowed
   * Columns (or association aliases) listed in hiddenFields are automatically excluded
   * from the searchable set, so hidden data can never be probed through search
   * Return null (or []) to ignore the search parameter for this request
   *
   * Set it to null to disable this functionality
   * @param {*} req
   * @param {*} res
   *
   * @returns {Array} Array of searchable column paths for the requesting user's type
   */
  controller.searchableFields = null;

  /**
   * Default column to sort by, it can be overriden by the query parameter `sort_by`
   * It can also be an array of columns for multi-column sorting, e.g. ['issue_year', 'issue_month']
   * Set it to null to avoid sorting
   */
  controller.defaultSortingColumn = 'id';

  /**
   * Default direction to sort by ('ASC' or 'DESC'), it can be overriden by the query parameter `sort_direction`
   * It can also be an array matching defaultSortingColumn per index; a single value applies to all columns
   */
  controller.defaultSortingDirection = 'ASC';

  /**
   * If true, the controller will return the handlers (functions) instead of just the express.Router object
   * This is useful when you want to use the handlers in another file.
   * { create, readMany, readOne, update, remove, router }
   * 
   * Set it to false to return just the express.Router object
   */
  controller.returnHandlers = false;

  /**
   * This function is called when an error occurs during the create operation
   * It can be used to handle the error and send a custom response
   * Set it to null to disable this functionality
   * 
   * @param {*} req
   * @param {*} res
   * @param {*} err 
   */
  onCreateError = null;

  /**
   * This function is called when an error occurs during the readMany operation
   * It can be used to handle the error and send a custom response
   * Set it to null to disable this functionality
   * 
   * @param {*} req
   * @param {*} res
   * @param {*} err 
   */
  onReadManyError = null;

  /**
   * This function is called when an error occurs during the readOne operation
   * It can be used to handle the error and send a custom response
   * Set it to null to disable this functionality
   * 
   * @param {*} req
   * @param {*} res
   * @param {*} err 
   */
  onReadOneError = null;

  /**
   * This function is called when an error occurs during the update operation
   * It can be used to handle the error and send a custom response
   * Set it to null to disable this functionality
   * 
   * @param {*} req
   * @param {*} res
   * @param {*} err 
   */
  onUpdateError = null;

  /**
   * This function is called when an error occurs during the remove operation
   * It can be used to handle the error and send a custom response
   * Set it to null to disable this functionality
   * 
   * @param {*} req
   * @param {*} res
   * @param {*} err 
   */
  onDeleteError = null;

  return controller;
};