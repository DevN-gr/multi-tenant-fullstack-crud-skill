const express = require('express');
const { Op, where: whereClause, cast, col } = require('sequelize');
const logger = require('../utils/logger');
const { wrap } = require('../utils/async-handler');

module.exports = (dbModel, options = {}) => {
  const {
    createDefaultAssociations,
    hiddenFields,
    extraFilters,
    deleteFilters,
    beforeSend,
    beforeUpdate,
    afterUpdate,
    afterDelete,
    readOnlyFields,
    searchableFields,
    allowedIncludes,
    onCreated,
    defaultIncludes,
    defaultSortingColumn = 'id',
    defaultSortingDirection = 'ASC',
    returnHandlers = false,
    onCreateError = null,
    onReadManyError = null,
    onReadOneError = null,
    onUpdateError = null,
    onDeleteError = null,
  } = options;

  // Helper function to create structured log context for Loki
  const createLogContext = (operation, req, additionalData = {}) => ({
    operation,
    model: dbModel.name,
    ...additionalData
  });

  // Helper function to log errors with full context and stack trace
  const logError = (operation, req, error, additionalData = {}) => {
    const context = createLogContext(operation, req, additionalData);
    logger.error({
      ...context,
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
        code: error.code,
        details: error.details || error.original || error
      }
    }, `CRUD ${operation} operation failed`);
  };

  // Helper function to log warnings with context
  const logWarning = (operation, req, message, additionalData = {}) => {
    const context = createLogContext(operation, req, additionalData);
    logger.warn({ ...context, ...additionalData }, message);
  };

  // Helper function to log debug information
  const logDebug = (operation, req, message, additionalData = {}) => {
    const context = createLogContext(operation, req, additionalData);
    logger.debug({ ...context, ...additionalData }, message);
  };

  // Helper function to log info messages
  const logInfo = (operation, req, message, additionalData = {}) => {
    const context = createLogContext(operation, req, additionalData);
    logger.info({ ...context, ...additionalData }, message);
  };

  /**
   * Combine the row being addressed with the scope conditions extraFilters
   * returned.
   *
   * A plain object spread is wrong here, and dangerously so: an authorization
   * hook that scopes by `id` — `{ id: req.user.CustomerId }` for a customer,
   * `{ id: req.user.OrganizationId }` for an owner, or the `{ id: -1 }` deny
   * — would *replace* the id in the URL. GET /customers/999 then quietly
   * returns your own record instead of nothing, and PUT /customers/999 edits
   * it. The addressed row and the scope must both hold, so where they name
   * the same column they are ANDed rather than one overwriting the other.
   */
  const mergeScope = (base, extra) => {
    if (!extra) return base;
    const overlapping = Reflect.ownKeys(extra).some((key) => key in base);
    return overlapping ? { [Op.and]: [base, extra] } : { ...base, ...extra };
  };

  /**
   * Would the row this request is about to create be inside the scope its own
   * `extraFilters` applies to reading it back?
   *
   * `extraFilters` is the authorization boundary for read, update and delete,
   * and create used to consult none of it: the only thing standing between a
   * POST and a row was whatever the controller happened to hand-write. A
   * portal customer could POST an note carrying somebody else's CustomerId,
   * and the front desk — refused the private model outright on every other verb —
   * could write a session note.
   *
   * A create is judged against the same conditions, evaluated in JavaScript
   * against the proposed row rather than in SQL against a stored one. Three
   * rules make that safe to do:
   *
   *   • A condition naming the primary key describes rows that already
   *     exist, so a new one can never satisfy it. `scope.DENY` is exactly
   *     that shape, and so is a customer's "your own file, only".
   *   • A condition on a column the body does not mention does not bear on
   *     it — the row takes the model's default, and the caller's own filters
   *     still apply when they come back for it.
   *   • Anything this cannot evaluate — an operator with no in-memory
   *     equivalent — refuses. A scope that cannot be checked is not a scope
   *     that has been satisfied.
   */
  const sameValue = (a, b) => {
    if (a === null || a === undefined || b === null || b === undefined) {
      return (a === null || a === undefined) && (b === null || b === undefined);
    }
    return String(a) === String(b);
  };

  const valueMatches = (actual, expected) => {
    if (Array.isArray(expected)) return expected.some((v) => valueMatches(actual, v));
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      const keys = Reflect.ownKeys(expected);
      if (!keys.length) return false;
      return keys.every((key) => {
        if (key === Op.eq) return valueMatches(actual, expected[key]);
        if (key === Op.ne) return !sameValue(actual, expected[key]);
        if (key === Op.in) return [].concat(expected[key]).some((v) => sameValue(actual, v));
        return false;                        // an operator we cannot judge
      });
    }
    return sameValue(actual, expected);
  };

  const scopeAllowsCreate = (body, condition) => {
    if (!condition) return true;
    const pk = dbModel.primaryKeyAttribute;

    return Reflect.ownKeys(condition).every((key) => {
      const value = condition[key];
      if (key === Op.and) return [].concat(value).every((c) => scopeAllowsCreate(body, c));
      if (key === Op.or) return [].concat(value).some((c) => scopeAllowsCreate(body, c));
      if (typeof key === 'symbol') return false;
      if (key === pk) return false;
      if (!Object.prototype.hasOwnProperty.call(body, key)) return true;
      return valueMatches(body[key], value);
    });
  };

  /**
   * Turn a client's `?include=` into association entries, or refuse it.
   *
   * The parameter used to be handed to `findAll` verbatim. `hiddenFields`
   * masks columns on the base model and nothing else, so every association
   * was a way around every access rule on the far side of it: the front desk read
   * private records through `customers?include=Record`, a portal customer read
   * the whole customer list through `users?include=AssignedCustomers`, and
   * `workspaces?include=Staff` handed back User rows with their password hashes
   * in them.
   *
   * So a controller names what may be eager-loaded, per role, and nothing
   * else is reachable. `password` is subtracted from every included model as
   * well, for the same reason crud.js subtracts it from the base one.
   */
  const resolveIncludes = async (req, res, raw) => {
    const requested = [...new Set(
      [].concat(raw).flatMap((entry) => String(entry).split(','))
        .map((name) => name.trim()).filter(Boolean)
    )];
    if (!requested.length) return null;

    const allowed = allowedIncludes ? (await allowedIncludes(req, res)) || [] : [];
    const refused = requested.filter((name) => !allowed.includes(name));
    if (refused.length) {
      throw new Error(`Association is not readable here: ${refused.join(', ')}`);
    }

    return requested.map((name) => {
      const association = dbModel.associations[name];
      if (!association) throw new Error(`Unknown association: ${name}`);
      return {
        association,
        required: false,
        attributes: { exclude: ['password'] }
      };
    });
  };

  /** A database failure a client caused, told apart from one it did not. */
  const failureFor = (err) => {
    const name = err && err.name;
    if (name === 'SequelizeUniqueConstraintError') return { status: 409, body: { error: 'conflict' } };
    if (name === 'SequelizeValidationError') return { status: 422, body: { error: 'invalid' } };
    if (name === 'SequelizeForeignKeyConstraintError') return { status: 422, body: { error: 'invalid_reference' } };
    return { status: 500, body: { error: 'server_error' } };
  };

  const NUMERIC_TYPE_KEYS = ['INTEGER', 'BIGINT', 'SMALLINT', 'MEDIUMINT', 'TINYINT', 'FLOAT', 'REAL', 'DOUBLE', 'DOUBLE PRECISION', 'DECIMAL', 'NUMBER'];

  // Casts a query-string filter value to the model attribute's type so the SQL
  // comparison stays typed on every dialect; throws on unknown columns, values
  // that cannot be cast, or operators that make no sense for the column type.
  const coerceFilterValue = (column, op, value, hidden) => {
    const attribute = dbModel.rawAttributes[column];
    if (!attribute) {
      throw new Error(`Unknown filter column: ${column}`);
    }
    /* A column hiddenFields keeps out of the response must not be reachable
       through the WHERE clause either. Filtering answers "is there a row
       where this is true" one bit at a time, which is the same column read
       slowly: `?by_password_like=$2a$%` returned the row and `ZZZ%` did not,
       so a bcrypt hash was legible a character at a time while the response
       body still had no `password` key in it. */
    if (hidden && hidden.includes(column)) {
      throw new Error(`Column is not filterable: ${column}`);
    }
    const typeKey = String(attribute.type.key || '').toUpperCase();

    if (typeKey === 'VIRTUAL') {
      throw new Error(`Column is not filterable: ${column}`);
    }
    if (NUMERIC_TYPE_KEYS.includes(typeKey)) {
      if (op === 'like') {
        throw new Error(`Operator 'like' is not supported on numeric column: ${column}`);
      }
      const num = Number(value);
      if (value === null || String(value).trim() === '' || Number.isNaN(num)) {
        throw new Error(`Invalid numeric value for column '${column}': ${value}`);
      }
      return num;
    }
    if (typeKey === 'BOOLEAN') {
      if (op !== 'eq' && op !== 'ne' && op !== 'in') {
        throw new Error(`Operator '${op}' is not supported on boolean column: ${column}`);
      }
      if (value === true || value === 'true' || value === '1' || value === 1) return true;
      if (value === false || value === 'false' || value === '0' || value === 0) return false;
      throw new Error(`Invalid boolean value for column '${column}': ${value}`);
    }
    if (typeKey === 'DATE' || typeKey === 'DATEONLY') {
      if (op === 'like') {
        throw new Error(`Operator 'like' is not supported on date column: ${column}`);
      }
      if (value === null || Number.isNaN(new Date(value).getTime())) {
        throw new Error(`Invalid date value for column '${column}': ${value}`);
      }
      return value;
    }
    return value;
  };

  /**
   * Coerce a request body to the types the model declares.
   *
   * JSON carries "7" and 7 equally happily, and a browser produces the former
   * without trying: `data-id` attributes, `<select>` values and the URL are
   * all text. Sequelize converts on its way to SQL, so the row saves either
   * way — but anything that reasons about the body *before* the write compares
   * in JavaScript, and `7 === "7"` is false.
   *
   * That is not a cosmetic difference here. The scheduling rules run on the body:
   * a create carrying MemberId "7" found no clash with the task held by
   * member 7, and one customer per member per slot — the product's first
   * invariant — could be walked straight past by sending a string.
   *
   * The same rule the query filters already follow: the model declares the
   * type, the framework applies it. Values that cannot be converted are left
   * alone for the database to reject with a real error.
   */
  const coerceBody = (body) => {
    if (!body || typeof body !== 'object') return body;

    Object.keys(body).forEach((key) => {
      const attribute = dbModel.rawAttributes[key];
      if (!attribute) return;                       // not a column; leave it

      const typeKey = String(attribute.type.key || '').toUpperCase();
      const value = body[key];
      if (value === null || value === undefined || value === '') return;

      if (NUMERIC_TYPE_KEYS.includes(typeKey) && typeof value === 'string') {
        const num = Number(value);
        if (!Number.isNaN(num)) body[key] = num;
        return;
      }
      if (typeKey === 'BOOLEAN' && typeof value === 'string') {
        if (value === 'true' || value === '1') body[key] = true;
        else if (value === 'false' || value === '0') body[key] = false;
      }
    });

    return body;
  };

  const create = async (req, res) => {
    logDebug('create', req, 'Starting create operation', { bodyKeys: Object.keys(req.body) });

    coerceBody(req.body);

    if (createDefaultAssociations) {
      logDebug('create', req, 'Creating default associations');
      await createDefaultAssociations(req, res);
    }

    const newEntry = req.body;
    // A negative id is how createDefaultAssociations refuses a create — it is
    // the framework's documented deny signal, used here by every controller
    // that has to reject a scheduling, a payment or an out-of-scope association.
    // Both branches must stop: falling through would insert the very row the
    // hook just refused, and then respond a second time on top of the error.
    if (newEntry.id < 0) {
      logWarning('create', req, 'Invalid ID provided in create request', { invalidId: newEntry.id });
      if (onCreateError) {
        onCreateError(req, res, new Error(`Invalid ID: ${newEntry.id}`));
      }
      else {
        res.status(403).json({ error: 'forbidden' });
      }
      return;
    }
    delete newEntry.id;

    /* The same boundary read, update and delete are held to. See
       scopeAllowsCreate: a create that lands outside the caller's own scope
       is refused rather than written and then hidden from them. */
    if (extraFilters) {
      const scopeCondition = await extraFilters(req, res);
      if (!scopeAllowsCreate(newEntry, scopeCondition)) {
        logWarning('create', req, 'Create refused: outside the caller\'s scope');
        if (!res.headersSent) res.status(403).json({ error: 'forbidden' });
        return;
      }
    }

    logDebug('create', req, 'Attempting to create new entry', { 
      entryData: Object.keys(newEntry).reduce((acc, key) => {
        // Don't log sensitive data
        if (['password', 'token', 'secret'].includes(key.toLowerCase())) {
          acc[key] = '[REDACTED]';
        } else {
          acc[key] = newEntry[key];
        }
        return acc;
      }, {})
    });

    dbModel.create(newEntry)
      .then(async (dboNewEntry) => {
        logInfo('create', req, 'Entry created successfully', { createdId: dboNewEntry.id });

        if (onCreated) {
          logDebug('create', req, 'Executing onCreated callback');
          await onCreated(req, res, dboNewEntry);
        }

        var excludeFields = ['password'];

        if (hiddenFields) {
          var result = await hiddenFields(req, res);
          if (result && result.length > 0) {
            excludeFields = excludeFields.concat(result);
          }
        }

        logDebug('create', req, 'Hiding sensitive fields', { hiddenFieldsCount: excludeFields.length });
        excludeFields.forEach(field => {
          dboNewEntry.dataValues[field] = undefined;
        });

        if (!res.headersSent) res.json(dboNewEntry);
      })
      .catch(function (err) {
        logError('create', req, err, { entryKeys: Object.keys(newEntry) });

        if (onCreateError) {
          onCreateError(req, res, err);
        }
        else if (!res.headersSent) {
          /* Never 200. A unique constraint answered as an empty success is
             how a member's session note was discarded while the interface
             said it had been saved. */
          const failure = failureFor(err);
          res.status(failure.status).json(failure.body);
        }
      });
  };

  const readMany = async (req, res) => {
    logDebug('readMany', req, 'Starting readMany operation', { 
      queryParamCount: Object.keys(req.query).length 
    });

    var queryFilter = req.query;
    var operations = [];
    var columns = [];
    var values = [];
    var where_operators = [];
    var filter_in = [];
    var show_deleted = req.query.show_deleted || '';
    delete queryFilter.show_deleted;

    logDebug('readMany', req, 'Processing query parameters', { 
      totalParams: Object.keys(req.query).length,
      showDeleted: show_deleted 
    });

    Object.getOwnPropertyNames(req.query).forEach(property => {
      if (property.startsWith("by_")) {

        try {
          var arr = property.split("_");
          operations.push(arr[arr.length - 1]);
          arr.pop();
          arr.shift();
          columns.push(arr.join("_"));
          values.push(req.query[property]);
          delete queryFilter[property];
          logDebug('readMany', req, 'Parsed by_ parameter', { 
            property, 
            operation: arr[arr.length - 1], 
            column: arr.join("_") 
          });
        }
        catch (error) {
          logWarning('readMany', req, 'Cannot parse by_ parameter', { 
            property, 
            error: error.message,
            stack: error.stack 
          });
        }
      }

      if (property.startsWith("in_")) {
        try {
          var arr = property.split("_");
          operations.push(arr[0]);
          columns.push(arr.slice(1).join("_"));
          logDebug('readMany', req, 'Processing in_ parameter', { 
            property, 
            value: req.query[property] 
          });
          let v = JSON.parse('[' + req.query[property] + ']');
          values.push(v);
          delete queryFilter[property];
        }
        catch (error) {
          logWarning('readMany', req, 'Cannot parse in_ parameter', { 
            property, 
            error: error.message,
            stack: error.stack 
          });
        }
      }

    });

    var queries = [];
    var extraQueryFilters = {};
    var sort_by = req.query.sort_by || defaultSortingColumn;
    var sort_dir = req.query.sort_direction || defaultSortingDirection;
    var query_offset = parseInt(req.query.offset, 10) || 0;
    var query_limit = parseInt(req.query.limit, 10) || 0;
    var include_extra = req.query.include || null;
    var with_count = req.query.with_count === 'true';
    var count_only = req.query.count_only === 'true';
    var search_query = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    delete queryFilter.sort_by;
    delete queryFilter.sort_direction;
    delete queryFilter.offset;
    delete queryFilter.limit;
    delete queryFilter.include;
    delete queryFilter.with_count;
    delete queryFilter.count_only;
    delete queryFilter.search;

    logDebug('readMany', req, 'Query configuration', {
      sortBy: sort_by,
      sortDirection: sort_dir,
      offset: query_offset,
      limit: query_limit,
      includeExtra: include_extra,
      operationsCount: operations.length
    });

    var excludeFields = ['password'];

    if (hiddenFields) {
      var hidden_result = await hiddenFields(req, res);
      if (hidden_result && hidden_result.length > 0) {
        excludeFields = excludeFields.concat(hidden_result);
        logDebug('readMany', req, 'Hidden fields applied', { hiddenFieldsCount: hidden_result.length });
      }
    }

    const KNOWN_OPERATORS = ['eq', 'ne', 'gt', 'lt', 'lte', 'gte', 'like', 'in'];
    try {
      if (include_extra) {
        include_extra = await resolveIncludes(req, res, include_extra);
      }
      if (sort_by) {
        sort_by = Array.isArray(sort_by) ? sort_by : [sort_by];
        sort_dir = (Array.isArray(sort_dir) ? sort_dir : [sort_dir]).map(dir => String(dir).toUpperCase());
        sort_by.forEach(column => {
          if (!dbModel.rawAttributes[column]) {
            throw new Error(`Unknown sort column: ${column}`);
          }
          /* Ordering by a hidden column leaks it too, one comparison at a
             time. Same reasoning as the filter check above. */
          if (excludeFields.includes(column)) {
            throw new Error(`Column is not sortable: ${column}`);
          }
        });
        sort_dir.forEach(dir => {
          if (dir !== 'ASC' && dir !== 'DESC') {
            throw new Error(`Invalid sort direction: ${dir}`);
          }
        });
      }
      if (query_offset < 0 || query_limit < 0) {
        throw new Error('offset and limit must be non-negative');
      }
      Object.getOwnPropertyNames(queryFilter).forEach(column => {
        queryFilter[column] = Array.isArray(queryFilter[column])
          ? queryFilter[column].map(v => coerceFilterValue(column, 'in', v, excludeFields))
          : coerceFilterValue(column, 'eq', queryFilter[column], excludeFields);
      });
      columns.forEach((column, idx) => {
        const op = operations[idx];
        if (!KNOWN_OPERATORS.includes(op)) {
          throw new Error(`Unknown filter operator '${op}' for column: ${column}`);
        }
        values[idx] = op === 'in'
          ? values[idx].map(v => coerceFilterValue(column, op, v, excludeFields))
          : coerceFilterValue(column, op, values[idx], excludeFields);
      });
    }
    catch (validationError) {
      logWarning('readMany', req, 'Invalid query parameter', { error: validationError.message });
      res.status(400).json({ error: validationError.message });
      return;
    }

    if (extraFilters) {
      logDebug('readMany', req, 'Applying extra filters');
      extraQueryFilters = await extraFilters(req, res);
      queryFilter = mergeScope(queryFilter, extraQueryFilters);
    }

    operations.forEach(op => {
      if (op == "eq") {
        where_operators.push(Op.eq);
      }
      else if (op == "ne") {
        where_operators.push(Op.ne);
      }
      else if (op == "gt") {
        where_operators.push(Op.gt);
      }
      else if (op == "lt") {
        where_operators.push(Op.lt);
      }
      else if (op == "lte") {
        where_operators.push(Op.lte);
      }
      else if (op == "gte") {
        where_operators.push(Op.gte);
      }
      else if (op == "like") {
        where_operators.push(Op.like);
      }
      else if (op == "in") {
        where_operators.push(Op.in);
      }
    });

    queries.push(queryFilter);
    where_operators.forEach(op => {
      if (op === Op.like) {
        let prefix = '%';
        let suffix = '%';
        queries.push({ [columns.shift()]: { [op]: prefix + values.shift() + suffix } });
      }
      else {
        queries.push({ [columns.shift()]: { [op]: values.shift() } });
      }
    });

    if (!include_extra && defaultIncludes) {
      include_extra = await defaultIncludes(req, res);
      logDebug('readMany', req, 'Default includes applied', { includesCount: include_extra?.length || 0 });
    }

    var search_associations = [];
    if (search_query.length >= 2 && searchableFields) {
      try {
        // A user type must never be able to search a column that hiddenFields hides from it,
        // otherwise search becomes an existence oracle for hidden data. For $Alias.column$
        // paths both the full path and the bare alias (hidden association) are checked
        const search_fields = (await searchableFields(req, res) || []).filter(field => {
          if (field.startsWith('$')) {
            const alias = field.slice(1).split('.')[0];
            return !excludeFields.includes(field) && !excludeFields.includes(alias);
          }
          return !excludeFields.includes(field);
        });
        const NUMERIC_TYPES = ['INTEGER', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'REAL'];

        if (search_fields.length > 0) {
          // Every whitespace-separated term must match at least one searchable column
          search_query.split(/\s+/).forEach(term => {
            const pattern = '%' + term + '%';
            queries.push({
              [Op.or]: search_fields.map(field => {
                if (field.startsWith('$')) {
                  return { [field]: { [Op.like]: pattern } };
                }
                const attribute = dbModel.rawAttributes[field];
                if (!attribute) {
                  throw new Error(`Unknown search column: ${field}`);
                }
                if (NUMERIC_TYPES.includes(attribute.type.key)) {
                  // LIKE on a numeric column needs an explicit cast
                  return whereClause(cast(col(`${dbModel.name}.${field}`), 'CHAR'), { [Op.like]: pattern });
                }
                return { [field]: { [Op.like]: pattern } };
              })
            });
          });

          // $Alias.column$ paths need their association joined. Only to-one associations
          // are allowed so the flat (subQuery: false) queries below cannot multiply rows
          search_associations = [...new Set(
            search_fields.filter(f => f.startsWith('$')).map(f => f.slice(1).split('.')[0])
          )].map(alias => {
            const association = dbModel.associations[alias];
            if (!association) {
              throw new Error(`Unknown search association: ${alias}`);
            }
            if (!association.isSingleAssociation) {
              throw new Error(`Search associations must be to-one (belongsTo/hasOne): ${alias}`);
            }
            return { association, required: false, attributes: [] };
          });

          if (search_associations.length > 0) {
            const aliasOf = (entry) => typeof entry === 'string'
              ? entry : (entry.as || entry.association?.as || entry.model?.name);
            let includes = include_extra ? [].concat(include_extra) : [];
            search_associations.forEach(entry => {
              if (!includes.some(existing => aliasOf(existing) === entry.association.as)) {
                includes.push(entry);
              }
            });
            include_extra = includes;
          }

          logDebug('readMany', req, 'Search applied', {
            searchFieldsCount: search_fields.length,
            searchAssociationsCount: search_associations.length
          });
        }
      }
      catch (searchError) {
        logError('readMany', req, searchError, { search: search_query });
        res.status(500).json({ error: searchError.message });
        return;
      }
    }

    var final_query = {
      where: queries,
      attributes: { exclude: excludeFields },
      include: include_extra,
      offset: query_offset,
      paranoid: !(show_deleted == 'true'),
    };

    if (sort_by) {
      // A single direction applies to all sort columns
      const order = sort_by.map((column, idx) => [column, sort_dir[idx] || sort_dir[sort_dir.length - 1]]);
      final_query = { ...final_query, ...{ order } };
    }

    if (query_limit > 0) {
      final_query = { ...final_query, ...{ limit: query_limit } };
    }

    // Searching across associations needs a flat query (subQuery: false) so the WHERE clause
    // can see the joined columns. When paginating, the matching ids are resolved first through
    // a flat query joining only the to-one search associations — with a plain flat query,
    // hasMany entries in the includes would make LIMIT count join rows instead of entities.
    const search_id_paging = search_associations.length > 0 && (query_limit > 0 || query_offset > 0);
    if (search_id_paging) {
      try {
        const pk = dbModel.primaryKeyAttribute;
        const idQuery = {
          where: queries,
          attributes: [pk],
          include: search_associations,
          offset: query_offset,
          paranoid: final_query.paranoid,
          subQuery: false,
          raw: true,
        };
        if (final_query.order) idQuery.order = final_query.order;
        if (query_limit > 0) idQuery.limit = query_limit;

        const matchedIds = (await dbModel.findAll(idQuery)).map(row => row[pk]);
        final_query.where = { [pk]: matchedIds };
        final_query.offset = 0;
        delete final_query.limit;
      }
      catch (err) {
        logError('readMany', req, err, { search: search_query });
        if (onReadManyError) {
          onReadManyError(req, res, err);
        }
        else if (!res.headersSent) {
          const failure = failureFor(err);
          res.status(failure.status).json(failure.body);
        }
        return;
      }
    } else if (search_associations.length > 0) {
      final_query.subQuery = false;
    }

    logDebug('readMany', req, 'Executing database query', {
      whereClausesCount: queries.length,
      excludedFieldsCount: excludeFields.length,
      paranoid: final_query.paranoid
    });

    const buildMeta = (count) => {
      const meta = {
        total: count,
        offset: query_offset,
        limit: query_limit,
      };
      if (query_limit > 0) {
        meta.pages = Math.ceil(count / query_limit);
        meta.page = Math.floor(query_offset / query_limit) + 1;
      }
      return meta;
    };

    // distinct is required so hasMany includes don't inflate the count with joined rows.
    // `queries` intentionally still holds the pre-search-id-paging filters, so counts
    // always reflect the full match set, not the current page
    const countMatches = () => dbModel.count({
      where: queries,
      include: include_extra,
      paranoid: final_query.paranoid,
      distinct: true,
    });

    let queryPromise;
    if (count_only) {
      // No rows are fetched, only the COUNT query runs
      queryPromise = countMatches().then(count => ({ rows: null, count }));
    } else if (with_count && search_id_paging) {
      queryPromise = Promise.all([dbModel.findAll(final_query), countMatches()])
        .then(([rows, count]) => ({ rows, count }));
    } else if (with_count) {
      queryPromise = dbModel.findAndCountAll({ ...final_query, distinct: true });
    } else {
      queryPromise = dbModel.findAll(final_query).then(rows => ({ rows, count: null }));
    }

    queryPromise
      .then(async ({ rows, count }) => {
        logInfo('readMany', req, 'Query executed successfully', {
          resultCount: rows?.length || 0,
          hasResults: (rows?.length || 0) > 0,
          totalCount: count
        });

        if (count_only) {
          res.json(buildMeta(count));
          return;
        }

        let result = rows;
        if (beforeSend) {
          logDebug('readMany', req, 'Executing beforeSend callback');
          result = await beforeSend(req, res, result);
        }

        if (count === null) {
          res.json(result || []);
          return;
        }

        res.json({ data: result || [], meta: buildMeta(count) });
      })
      .catch(function (err) {
        logError('readMany', req, err, {
          queryConfig: {
            sortBy: sort_by,
            sortDirection: sort_dir,
            offset: query_offset,
            limit: query_limit,
            paranoid: final_query.paranoid
          }
        });

        if (onReadManyError) {
          onReadManyError(req, res, err);
        }
        else if (!res.headersSent) {
          /* Never `200 []`. A query that failed and a query that matched
             nothing render as the same confident empty state. */
          const failure = failureFor(err);
          res.status(failure.status).json(failure.body);
        }
      })
  };

  const readOne = async (req, res) => {
    logDebug('readOne', req, 'Starting readOne operation', { requestedId: req.params._id });

    var queryFilter = { id: req.params._id };
    var include_extra = req.query.include || null;
    var extraQueryFilters = {};
    var show_deleted = req.query.show_deleted || '';
    delete queryFilter.show_deleted;

    if (extraFilters) {
      logDebug('readOne', req, 'Applying extra filters');
      extraQueryFilters = await extraFilters(req, res);
      queryFilter = mergeScope(queryFilter, extraQueryFilters);
    }

    var excludeFields = ['password'];

    if (hiddenFields) {
      var result = await hiddenFields(req, res);
      if (result && result.length > 0) {
        excludeFields = excludeFields.concat(result);
        logDebug('readOne', req, 'Hidden fields applied', { hiddenFieldsCount: result.length });
      }
    }

    if (include_extra) {
      try {
        include_extra = await resolveIncludes(req, res, include_extra);
      }
      catch (validationError) {
        logWarning('readOne', req, 'Invalid include parameter', { error: validationError.message });
        res.status(400).json({ error: validationError.message });
        return;
      }
    }

    if (!include_extra && defaultIncludes) {
      include_extra = await defaultIncludes(req, res);
      logDebug('readOne', req, 'Default includes applied', { includesCount: include_extra?.length || 0 });
    }

    logDebug('readOne', req, 'Executing database query', {
      queryFilter,
      excludedFieldsCount: excludeFields.length,
      includeExtra: !!include_extra,
      paranoid: !(show_deleted == 'true')
    });

    dbModel.findOne({
      where: queryFilter,
      attributes: { exclude: excludeFields },
      include: include_extra,
      paranoid: !(show_deleted == 'true'),
    })
      .then(async (result) => {
        if (result) {
          logInfo('readOne', req, 'Record found successfully', { foundId: result.id });
        } else {
          logInfo('readOne', req, 'No record found matching criteria', { requestedId: req.params._id });
        }

        if (beforeSend) {
          logDebug('readOne', req, 'Executing beforeSend callback');
          result = await beforeSend(req, res, result);
        }

        res.json(result || {});
      })
      .catch(function (err) {
        logError('readOne', req, err, {
          requestedId: req.params._id,
          queryFilter,
          paranoid: !(show_deleted == 'true')
        });

        if (onReadOneError) {
          onReadOneError(req, res, err);
        }
        else if (!res.headersSent) {
          const failure = failureFor(err);
          res.status(failure.status).json(failure.body);
        }
      });
  }

  const update = async (req, res) => {
    logDebug('update', req, 'Starting update operation', { 
      updateId: req.params._id,
      bodyKeys: Object.keys(req.body)
    });

    const body = coerceBody(req.body);

    var queryFilter = { id: req.params._id };
    var extraQueryFilters = {};

    if (extraFilters) {
      logDebug('update', req, 'Applying extra filters');
      extraQueryFilters = await extraFilters(req, res);
      queryFilter = mergeScope(queryFilter, extraQueryFilters);
    }

    // These fields cannot be changed from the outside world
    if (readOnlyFields) {
      var readOnlyFieldsArray = await readOnlyFields(req, res);
      const removedFields = [];
      readOnlyFieldsArray.forEach(property => {
        if (Object.hasOwnProperty.bind(body)(property)) {
          removedFields.push(property);
          delete body[property];
        }
      });
      if (removedFields.length > 0) {
        logWarning('update', req, 'Read-only fields removed from update', { 
          removedFields,
          totalRemovedCount: removedFields.length 
        });
      }
    }

    /* Identity and the timestamps are the framework's, never the client's.
       This is not a duplicate of readOnlyFields: those are per-controller and
       none of them listed `id`, so a PUT carrying one rewrote the primary key
       — cascading down every foreign key that referenced it, and leaving no
       audit row at all, because the audit field map has no entry for a column
       nobody is supposed to be able to change. */
    delete body.id;
    delete body.createdAt;
    delete body.updatedAt;
    delete body.deletedAt;

    var shouldUpdate = true;
    if (beforeUpdate) {
      logDebug('update', req, 'Executing beforeUpdate callback');
      shouldUpdate = await beforeUpdate(req, res, body, queryFilter);
      logDebug('update', req, 'beforeUpdate callback result', { shouldUpdate });
    }

    if (shouldUpdate) {
      logDebug('update', req, 'Executing database update', {
        queryFilter,
        updateFields: Object.keys(body).reduce((acc, key) => {
          // Don't log sensitive data
          if (['password', 'token', 'secret'].includes(key.toLowerCase())) {
            acc[key] = '[REDACTED]';
          } else {
            acc[key] = body[key];
          }
          return acc;
        }, {})
      });

      dbModel.update(body, { where: queryFilter })
        .then(async (result) => {
          const updatedCount = result[0];
          logInfo('update', req, 'Update operation completed', { 
            updatedCount,
            wasSuccessful: updatedCount > 0,
            targetId: req.params._id
          });
          
          /* Awaited for the same reason as afterDelete above. */
          if (afterUpdate) {
            logDebug('update', req, 'Executing afterUpdate callback');
            await afterUpdate(req, res, body, queryFilter);
          }

          if (!res.headersSent) res.json({ updated: result[0] })
        })
        .catch(function (err) {
          logError('update', req, err, {
            targetId: req.params._id,
            queryFilter,
            updateFieldsCount: Object.keys(body).length
          });

          if (onUpdateError) {
            onUpdateError(req, res, err);
          }
          else if (!res.headersSent) {
            const failure = failureFor(err);
            res.status(failure.status).json(failure.body);
          }
        });
    }
    else {
      logInfo('update', req, 'Update operation skipped by beforeUpdate callback', {
        targetId: req.params._id
      });
      /* A hook that refuses an update usually needs to say why — which rule
         was broken, which slot was taken — so it answers for itself and
         returns false. Without this guard the framework would then send a
         second, contentless `{ updated: 0 }` on top of it and Express would
         throw ERR_HTTP_HEADERS_SENT. `{ updated: 0 }` remains the answer for
         a hook that simply declines without explaining. */
      if (!res.headersSent) res.json({ updated: 0 });
    }
  };

  const remove = async (req, res) => {
    logDebug('remove', req, 'Starting delete operation', { deleteId: req.params._id });

    var queryFilter = { id: req.params._id };
    var extraQueryFilters = {};

    /* extraFilters is the authorization boundary for read, update AND delete.
       It used to be applied here only when a deleteFilters hook happened to
       exist as well — so any resource that authorized reads but had nothing
       extra to say about deletion was deletable by id, by anybody who could
       reach the route, across every tenant. The two hooks are independent:
       extraFilters always applies, deleteFilters narrows further. */
    if (extraFilters) {
      logDebug('remove', req, 'Applying extra filters');
      extraQueryFilters = await extraFilters(req, res);
      queryFilter = mergeScope(queryFilter, extraQueryFilters);
    }

    if (deleteFilters) {
      logDebug('remove', req, 'Applying delete-specific filters');
      var deleteFiltersArray = await deleteFilters(req, res);
      if (deleteFiltersArray) {
        queryFilter = mergeScope(queryFilter, deleteFiltersArray);
        logDebug('remove', req, 'Delete filters applied', {
          deleteFiltersCount: Reflect.ownKeys(deleteFiltersArray).length
        });
      }
    }

    logDebug('remove', req, 'Executing database delete', { queryFilter });

    dbModel.destroy({ where: queryFilter })
      .then(async (result) => {
        logInfo('remove', req, 'Delete operation completed', { 
          deletedCount: result,
          wasSuccessful: result > 0,
          targetId: req.params._id
        });

        /* Awaited, unlike the template it came from. A hook here is not a
           notification, it is the rest of the operation: reversing a payment
           un-settles the sessions it paid for. Left unawaited, the API answers
           OK before any of that has happened, and a client that re-reads
           immediately — which is exactly what a UI does — sees the old state
           and is not wrong to. A hook that genuinely wants to fire and forget
           can still start its work without awaiting it. */
        if (afterDelete) {
          logDebug('remove', req, 'Executing afterDelete callback');
          await afterDelete(req, res, queryFilter, result);
        }
        
        if (!res.headersSent) res.json({ status: 'OK' });
      })
      .catch(function (err) {
        logError('remove', req, err, {
          targetId: req.params._id,
          queryFilter
        });

        if (onDeleteError) {
          onDeleteError(req, res, err);
        }
        else if (!res.headersSent) {
          const failure = failureFor(err);
          res.status(failure.status).json(failure.body);
        }
      });
  };

  const router = express.Router();

  /* Every handler here is `async`, and Express 4 turns a rejected one into an
     unhandled rejection that kills the process rather than an error the
     middleware in app.js can answer. `wrap` is what makes that comment in
     app.js true. */
  router.post('/', wrap(create));
  router.get('/', wrap(readMany));
  router.get('/:_id', wrap(readOne));
  router.put('/:_id', wrap(update));
  router.delete('/:_id', wrap(remove));

  if (returnHandlers) {
    return {
      create: create,
      readMany: readMany,
      readOne: readOne,
      update: update,
      remove: remove,
      router: router,
    };
  }

  return router;
}